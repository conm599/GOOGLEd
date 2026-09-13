import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { netClient } from '../net/NetClient'
import { loadSettings, saveSettings } from '../settings'
import { getPlatform, type FetchInit } from '../platform'
import { logger } from '../logger'
import type { UpdateInfo } from '../types'

const RELEASE_API = 'https://api.github.com/repos/conm599/GOOGLEd/releases/latest'

/** 下载的更新包存放处：userData/cache/update，纳入磁盘缓存清理（手动清理 + 阈值自动清理） */
export function updateCacheDir(): string {
  return path.join(getPlatform().userDataDir(), 'cache', 'update')
}

export function updateCacheFiles(): Promise<string[]> {
  return fsp.readdir(updateCacheDir()).catch(() => [] as string[])
}

/** 三段式版本号比较：>0 表示 a 更新 */
function cmpVersion(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}

/**
 * 应用更新（win 与 linux CLI 共用）：
 * - 查询 GitHub Releases 最新版（公共仓库，无需 token），按平台挑选更新包资产
 * - 下载到缓存目录（纳入缓存清理），完成后交给平台落定（win 拉起安装器；linux 替换自身二进制）
 * - 大陆访问 GitHub 慢：下载按「设置里的代理 > 自动探测到的本机代理 > 直连」多通道尝试，
 *   每个通道失败自动换下一个并断点续传；45 秒无数据视为通道停滞
 * - 打包版启动 15 秒后静默检查（每 24h 一次），被忽略的版本不再提示；开发版只手动检查
 */
class UpdateService {
  private downloading = false
  /** 自动探测到的本机代理（undefined=本次运行还没探测过；null=没探测到） */
  private probedProxy: string | null | undefined = undefined

  /** 查询最新版；返回 status: latest（已是最新）/ available（有更新）/ error */
  async manualCheck(): Promise<{ status: 'latest' | 'available' | 'error'; info?: UpdateInfo; error?: string }> {
    try {
      const res = await netClient.request(RELEASE_API, {
        timeoutMs: 20000,
        headers: { accept: 'application/vnd.github+json' }
      })
      if (!res.ok) return { status: 'error', error: `查询更新失败（HTTP ${res.status}）` }
      const data = JSON.parse(await res.text()) as {
        tag_name?: string
        body?: string
        assets?: { name: string; browser_download_url: string }[]
      }
      const version = (data.tag_name || '').replace(/^v/, '')
      if (!version) return { status: 'error', error: '未获取到最新版本号' }
      if (cmpVersion(version, getPlatform().version()) <= 0) return { status: 'latest' }
      const asset = getPlatform().pickUpdateAsset(data.assets || [])
      if (!asset) return { status: 'error', error: '最新版本没有可用的更新包' }
      return {
        status: 'available',
        info: {
          version,
          notes: (data.body || '').slice(0, 4000),
          assetUrl: asset.url,
          assetName: asset.name
        }
      }
    } catch (e) {
      return { status: 'error', error: `查询更新失败：${(e as Error).message}` }
    }
  }

  /** 「忽略这次更新」：记录版本号，之后不再为该版本弹窗 */
  ignore(version: string): void {
    const s = loadSettings()
    saveSettings({ ...s, ignoredUpdateVersion: version })
    logger.info('用户忽略了更新', version)
  }

  /** 更新下载应尝试的通道，按优先级：手动配置的代理 > 自动探测到的本机代理 > 直连（主通道）。
   * 代理/系统代理模式下主通道本身已带代理，直接走主通道 */
  private async downloadCandidates(): Promise<(string | null)[]> {
    const s = loadSettings()
    const manual = (s.updateProxy || '').trim()
    if (manual) return [manual]
    if (s.netMode === 'proxy' || s.netMode === 'system') return [null]
    const probed = await this.autoProbeProxies()
    return [...probed, null]
  }

  /** 探测本机常见代理端口（连接被拒=秒失败；有响应即视为可用），结果本次运行内缓存 */
  private async autoProbeProxies(): Promise<string[]> {
    if (this.probedProxy !== undefined) return this.probedProxy ? [this.probedProxy] : []
    const found = await getPlatform().probeLocalProxies()
    this.probedProxy = found[0] ?? null
    logger.info('更新下载通道探测', this.probedProxy ? `发现本机代理 ${this.probedProxy}` : '未发现本机代理，使用直连')
    return found
  }

  /** 用指定代理（null=主通道，跟随代理/系统代理模式）发起请求；rangeStart 用于断点续传 */
  private async fetchVia(url: string, proxy: string | null, timeoutMs: number, rangeStart?: number): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const headers: Record<string, string> = {}
      if (rangeStart !== undefined) headers.range = `bytes=${rangeStart}-`
      if (proxy === null) {
        return await netClient.request(url, { timeoutMs, headers, signal: controller.signal })
      }
      return await getPlatform().fetchViaProxy(proxy, url, {
        headers,
        cache: 'no-store',
        signal: controller.signal
      } as FetchInit)
    } finally {
      clearTimeout(timer)
    }
  }

  /** 下载更新包（带进度推送），完成后交给平台落定。
   * 多通道自动切换 + Range 断点续传 + 45 秒无数据看门狗 */
  async downloadAndInstall(info: UpdateInfo): Promise<void> {
    if (this.downloading) throw new Error('已有更新正在下载')
    this.downloading = true
    const dir = updateCacheDir()
    const dest = path.join(dir, info.assetName)
    try {
      await fsp.mkdir(dir, { recursive: true })
      // 只保留正在下载的这个，旧版本残留安装包清掉（也是缓存的一部分；目录残留一并递归删）
      for (const f of await updateCacheFiles()) {
        if (f !== info.assetName) await fsp.rm(path.join(dir, f), { force: true, recursive: true }).catch(() => undefined)
      }
      const candidates = await this.downloadCandidates()
      let lastError: Error | null = null
      for (const proxy of candidates) {
        try {
          logger.info(`更新包下载通道：${proxy || '直连（主通道）'}`)
          await this.downloadOnce(info, dest, proxy)
          logger.info(`更新包下载完成：${dest}`)
          await getPlatform().applyUpdate(dest, info)
          return
        } catch (e) {
          lastError = e as Error
          logger.warn(`更新包下载失败（${proxy || '直连'}）`, (e as Error).message)
          // 半截文件保留：下一通道用 Range 从断点接着下
        }
      }
      throw new Error(
        `下载失败：${lastError?.message || '所有通道均不可用'}。可在 设置→通用→下载代理 里填写本机代理端口后重试`
      )
    } finally {
      this.downloading = false
    }
  }

  /** 单通道完整下载（含 Range 续传与 45 秒空闲看门狗）；失败抛错由上层换通道 */
  private async downloadOnce(info: UpdateInfo, dest: string, proxy: string | null): Promise<void> {
    const existing = (await fsp.stat(dest).catch(() => null))?.size ?? 0
    const res = await this.fetchVia(info.assetUrl, proxy, 60000, existing > 0 ? existing : undefined)
    if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`)
    let offset = existing
    if (res.status === 200) offset = 0 // 服务端不支持 Range（返回全量）→ 从头写
    const contentRange = res.headers.get('content-range')
    const total =
      Number(contentRange?.split('/')[1]) || offset + (Number(res.headers.get('content-length')) || 0)
    const reader = res.body!.getReader()
    const fh = await fsp.open(dest, offset > 0 ? 'r+' : 'w')
    let received = offset
    let lastEmit = 0
    let idleReject: (e: Error) => void = () => undefined
    let idleTimer: NodeJS.Timeout | null = null
    const resetIdle = (): void => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => idleReject(new Error('下载停滞（45 秒无数据）')), 45000)
    }
    const watchdog = new Promise<never>((_, reject) => {
      idleReject = reject
    })
    resetIdle()
    try {
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), watchdog])
        if (done) break
        await fh.write(value!)
        received += value!.byteLength
        resetIdle()
        const now = Date.now()
        if (now - lastEmit > 300) {
          lastEmit = now
          this.emitProgress(received, total || received)
        }
      }
      this.emitProgress(received, total || received)
    } catch (e) {
      clearTimeout(idleTimer!)
      await reader.cancel().catch(() => undefined)
      throw e
    } finally {
      clearTimeout(idleTimer!)
      await fh.close()
    }
  }

  /** 打包版：启动 15 秒后静默检查，之后每 24 小时一次；被忽略的版本不提示 */
  startAutoCheck(): void {
    if (!getPlatform().isPackaged()) return
    const run = async (): Promise<void> => {
      const { info } = await this.manualCheck()
      if (info && loadSettings().ignoredUpdateVersion !== info.version) {
        logger.info('发现新版本', info.version)
        getPlatform().broadcast('update:available', info)
      }
    }
    setTimeout(() => void run().catch(() => undefined), 15_000)
    setInterval(() => void run().catch(() => undefined), 24 * 3600_000)
  }

  private emitProgress(received: number, total: number): void {
    getPlatform().broadcast('update:progress', { received, total })
  }
}

export const updateService = new UpdateService()
