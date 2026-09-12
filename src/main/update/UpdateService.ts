import { app, BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { netClient } from '../net/NetClient'
import { loadSettings, saveSettings } from '../settings'
import { logger } from '../logger'
import type { UpdateInfo } from '../../shared/types'

const RELEASE_API = 'https://api.github.com/repos/conm599/GOOGLEd/releases/latest'

/** 下载的安装包存放处：userData/cache/update，纳入磁盘缓存清理（手动清理 + 阈值自动清理） */
export function updateCacheDir(): string {
  return path.join(app.getPath('userData'), 'cache', 'update')
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
 * 应用内更新：
 * - 查询 GitHub Releases 最新版（公共仓库，无需 token）
 * - 下载安装包到缓存目录（netClient 出口，代理模式同样可用），完成后自动拉起安装器并退出应用
 * - 打包版启动 15 秒后静默检查（每 24h 一次），被忽略的版本不再提示；开发版只手动检查
 */
class UpdateService {
  private downloading = false

  /** 查询最新版；info=null 表示已是最新 */
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
      if (cmpVersion(version, app.getVersion()) <= 0) return { status: 'latest' }
      const assets = data.assets || []
      const asset = assets.find((a) => a.name.endsWith('.exe') && a.name.includes('Setup')) || assets.find((a) => a.name.endsWith('.exe'))
      if (!asset) return { status: 'error', error: '最新版本没有可用的安装包' }
      return {
        status: 'available',
        info: {
          version,
          notes: (data.body || '').slice(0, 4000),
          assetUrl: asset.browser_download_url,
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

  /** 下载安装包（带进度推送），完成后自动运行安装器并退出应用 */
  async downloadAndInstall(info: UpdateInfo): Promise<void> {
    if (this.downloading) throw new Error('已有更新正在下载')
    this.downloading = true
    const dir = updateCacheDir()
    const dest = path.join(dir, info.assetName)
    try {
      await fsp.mkdir(dir, { recursive: true })
      // 只保留正在下载的这个，旧版本残留安装包清掉（也是缓存的一部分）
      for (const f of await updateCacheFiles()) {
        if (f !== info.assetName) await fsp.rm(path.join(dir, f), { force: true }).catch(() => undefined)
      }
      const res = await netClient.request(info.assetUrl, { timeoutMs: 60000 })
      if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`)
      const total = Number(res.headers.get('content-length')) || 0
      const reader = res.body!.getReader()
      const fh = await fsp.open(dest, 'w')
      let received = 0
      let lastEmit = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          await fh.write(value)
          received += value.byteLength
          const now = Date.now()
          if (now - lastEmit > 300) {
            lastEmit = now
            this.emitProgress(received, total)
          }
        }
      } finally {
        await fh.close()
      }
      this.emitProgress(received, received)
      logger.info(`更新包下载完成：${dest}（${(received / 1024 / 1024).toFixed(1)}MB），启动安装器`)
      // 分离进程拉起 NSIS 安装器，退出应用让安装向导接管
      const child = spawn(dest, [], { detached: true, stdio: 'ignore', cwd: dir })
      child.unref()
      setTimeout(() => app.quit(), 800)
    } finally {
      this.downloading = false
    }
  }

  /** 打包版：启动 15 秒后静默检查，之后每 24 小时一次；被忽略的版本不提示 */
  startAutoCheck(): void {
    if (!app.isPackaged) return
    const run = async (): Promise<void> => {
      const { info } = await this.manualCheck()
      if (info && loadSettings().ignoredUpdateVersion !== info.version) {
        logger.info('发现新版本', info.version)
        for (const w of BrowserWindow.getAllWindows()) {
          if (!w.isDestroyed()) w.webContents.send('update:available', info)
        }
      }
    }
    setTimeout(() => void run().catch(() => undefined), 15_000)
    setInterval(() => void run().catch(() => undefined), 24 * 3600_000)
  }

  private emitProgress(received: number, total: number): void {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('update:progress', { received, total })
    }
  }
}

export const updateService = new UpdateService()
