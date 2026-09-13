import type { Settings } from '../types'
import { loadSettings } from '../settings'
import { getPlatform, type ProxyConfig, type FetchInit } from '../platform'
import { logger } from '../logger'

/** Worker 域名故障冷却时长：冷却期内请求自动切其他域名，到期自动切回（探测是否恢复） */
const BASE_COOLDOWN_MS = 90000

/**
 * 统一网络出口：
 * - direct   直连
 * - system   跟随系统代理
 * - proxy    自定义 HTTP / SOCKS5 代理
 * - workers  Cloudflare Workers 反代：https://worker.domain/https://www.googleapis.com/...
 * 所有对 Google 的请求（API / 上传会话 / OAuth / 缩略图）都必须经过这里，
 * 保证断点续传的每个分块请求都走同一条可用通道。
 * 实际网络栈由平台注入（win: Chromium net；linux: Node fetch + undici/socks 调度器）。
 */
export class NetClient {
  private appliedProxyKey = ''
  /** Worker 域名冷却表：base → 冷却截止时间。某域名挂起/持续 5xx 时冷却它，后续请求自动切到其他域名 */
  private baseCooldown = new Map<string, number>()

  async applySettings(s: Settings): Promise<void> {
    let key = ''
    const conf: ProxyConfig = { mode: 'direct' }
    if (s.netMode === 'system') {
      conf.mode = 'system'
      key = 'system'
    } else if (s.netMode === 'proxy' && s.proxyHost) {
      conf.mode = 'fixed_servers'
      conf.proxyRules =
        s.proxyProtocol === 'socks5'
          ? `socks5://${s.proxyHost}:${s.proxyPort}`
          : `http=${s.proxyHost}:${s.proxyPort};https=${s.proxyHost}:${s.proxyPort}`
      key = conf.proxyRules
    }
    if (key !== this.appliedProxyKey) {
      await getPlatform().applyProxy(conf)
      this.appliedProxyKey = key
      logger.info('代理已应用', { netMode: s.netMode, proxyRules: conf.proxyRules || 'direct' })
    }
  }

  /**
   * Workers 地址支持填多个域名（逗号/分号/空格/换行分隔，同一个 Worker 绑多域名时填全）。
   * 某个域名挂起或持续报错时自动冷却切到其他域名，冷却到期自动切回——等价于手动「删掉重填」的自动化。
   */
  private workerBases(): string[] {
    const s = loadSettings()
    if (s.netMode !== 'workers' || !s.workerBase) return []
    return [
      ...new Set(
        s.workerBase
          .split(/[\s,;，；]+/)
          .map((b) => b.trim().replace(/\/+$/, ''))
          .filter(Boolean)
      )
    ]
  }

  /** 优先返回未处于冷却期的域名；全部在冷却期则返回第一个（给它恢复的机会） */
  private pickBase(bases: string[]): string {
    const now = Date.now()
    return bases.find((b) => (this.baseCooldown.get(b) ?? 0) <= now) ?? bases[0]
  }

  /** 本次请求实际走了哪个 Worker 域名（直连/未命中 workerHosts 返回 undefined） */
  private usedBase(finalUrl: string): string | undefined {
    return this.workerBases().find((b) => finalUrl.startsWith(`${b}/`))
  }

  private coolBase(base: string): void {
    this.baseCooldown.set(base, Date.now() + BASE_COOLDOWN_MS)
  }

  /** workers 模式下把 Google 域名改写为 https://workerBase/https://目标 */
  rewrite(url: string): string {
    const bases = this.workerBases()
    if (!bases.length) return url
    let host = ''
    try {
      host = new URL(url).host
    } catch {
      return url
    }
    const s = loadSettings()
    const hosts = s.workerHosts.length ? s.workerHosts : ['www.googleapis.com', 'oauth2.googleapis.com']
    if (!hosts.includes(host)) return url
    return `${this.pickBase(bases)}/${url}`
  }

  /**
   * 发起请求。timeoutMs 覆盖连接+响应首字节；响应体流读取不受此限制。外部 signal 可中止整个请求/流。
   * 无请求体的幂等请求（GET 等）在网络层瞬时错误（断线/代理闪断/网络切换）时自动重试最多 3 次；
   * 自身超时中止（外部 signal 未触发时的 AbortError，如 CF Worker 偶发挂起）同样视为瞬时错误参与重试。
   * 带请求体的请求（分块 PUT 等）默认不重试，但 Workers 多域名时失败会自动换下一个域名重试
   * （重试次数=域名数；续传协议保证重复 PUT 幂等）。
   */
  async request(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const { timeoutMs = 60000, signal, ...rest } = init
    const maxAttempts = rest.body ? Math.max(1, this.workerBases().length) : 3
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.requestOnce(url, { timeoutMs, signal, ...rest })
      } catch (e) {
        const err = e as Error
        const selfTimeoutAbort = err.name === 'AbortError' && !signal?.aborted
        if (signal?.aborted || (!isTransientNetError(err) && !selfTimeoutAbort) || attempt >= maxAttempts) throw e
        await new Promise((r) => setTimeout(r, 800 * attempt))
      }
    }
  }

  private async requestOnce(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const { timeoutMs = 60000, signal, ...rest } = init
    let finalUrl = this.rewrite(url)
    // Workers 反代域名可能被 CF 边缘缓存 GET 响应，导致删除/更新后扫描到旧数据（旧文件 ID → 404）
    const s = loadSettings()
    if (s.netMode === 'workers' && s.workerBase) {
      finalUrl += (finalUrl.includes('?') ? '&' : '?') + `_gdcb=${Date.now()}`
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const onExternalAbort = () => controller.abort()
    if (signal) {
      if (signal.aborted) onExternalAbort()
      else signal.addEventListener('abort', onExternalAbort, { once: true })
    }
    const base = this.usedBase(finalUrl)
    try {
      const res = await getPlatform().fetch(finalUrl, {
        ...rest,
        cache: 'no-store',
        signal: controller.signal
      } as FetchInit)
      // 域名持续 5xx/429 也视为故障：冷却后让后续请求换域名
      if (base && (res.status >= 500 || res.status === 429)) this.coolBase(base)
      return res
    } catch (e) {
      // 网络层失败/自身超时 → 冷却该域名。用户主动暂停（外部 signal）不算域名故障
      if (base && !signal?.aborted) this.coolBase(base)
      throw e
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onExternalAbort)
    }
  }

  /** 便捷 JSON 请求 */
  async requestJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
    const res = await this.request(url, init)
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`)
    }
    return JSON.parse(text) as T
  }
}

export const netClient = new NetClient()

/**
 * 网络层瞬时错误（断线、代理闪断、网络切换等），可安全重试。
 * win/Chromium 报 ERR_* 串；linux/Node 抂 ECONNRESET、UND_ERR_* 等（多在 cause 里）。
 */
export function isTransientNetError(e: Error): boolean {
  const texts: string[] = [e.message]
  let c = (e as Error & { cause?: unknown }).cause
  for (let i = 0; i < 3 && c; i++) {
    texts.push(c instanceof Error ? c.message : String(c))
    c = (c as Error | undefined)?.cause
  }
  const all = texts.join('|')
  return /ERR_CONNECTION_RESET|ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_TIMED_OUT|ERR_TIMED_OUT|ERR_NAME_NOT_RESOLVED|ERR_SOCKET_NOT_CONNECTED|ERR_CONNECTION_CLOSED|ECONNRESET|ECONNABORTED|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|OtherSideClosed/.test(
    all
  )
}
