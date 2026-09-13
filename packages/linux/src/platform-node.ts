import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import * as tls from 'node:tls'
import { spawn } from 'node:child_process'
import { Agent, ProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici'
import { SocksClient } from 'socks'
import { setPlatform, type Platform, type ProxyConfig, type FetchInit } from '@core/platform'
import type { Settings, UpdateInfo } from '@core/types'
import { logger } from '@core/logger'

declare const __VERSION__: string

/** 构建期注入的版本号（esbuild define）；源码直跑时回退 dev 标记 */
export function currentVersion(): string {
  return typeof __VERSION__ === 'string' ? __VERSION__ : '0.0.0-dev'
}

/** 常见本机代理端口（与 win 版一致：v2rayN 10808/10809、clash 7890/7897、通用 socks 1080） */
const PROBE_PORTS = [10808, 7890, 10809, 7897, 1080]

// ---------- 路径 ----------

/** 数据目录：$GOOGLED_HOME > $XDG_CONFIG_HOME/googled > ~/.config/googled */
export function dataDir(): string {
  if (process.env.GOOGLED_HOME) return process.env.GOOGLED_HOME
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(xdg, 'googled')
}

function downloadsDir(): string {
  if (process.env.XDG_DOWNLOAD_DIR) {
    const p = process.env.XDG_DOWNLOAD_DIR.replace('$HOME', os.homedir())
    if (fs.existsSync(p)) return p
  }
  const homeDownloads = path.join(os.homedir(), 'Downloads')
  return fs.existsSync(homeDownloads) ? homeDownloads : os.homedir()
}

// ---------- token 加密（AES-256-GCM） ----------

/**
 * 密钥来源（二选一）：
 * 1. 环境变量 GOOGLED_TOKEN_PASSPHRASE（scrypt 派生）——密钥不落盘，适合多机/保密要求高的场景
 * 2. 数据目录下 token.key（随机 32 字节，0600 权限）——本机静态加密，防护等级对标 DPAPI（防其他用户，不防 root）
 */
function tokenKey(): Buffer {
  const pass = process.env.GOOGLED_TOKEN_PASSPHRASE
  if (pass) return crypto.scryptSync(pass, 'googled-cli-token-v1', 32)
  const keyFile = path.join(dataDir(), 'token.key')
  try {
    const k = fs.readFileSync(keyFile)
    if (k.length === 32) return k
  } catch {
    /* 首次生成 */
  }
  const k = crypto.randomBytes(32)
  fs.mkdirSync(dataDir(), { recursive: true })
  fs.writeFileSync(keyFile, k, { mode: 0o600 })
  try {
    fs.chmodSync(keyFile, 0o600)
  } catch {
    /* Windows 等无 posix 权限的系统忽略 */
  }
  return k
}

function aesEncrypt(plain: string): string {
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', tokenKey(), nonce)
  const enc = Buffer.concat([cipher.update(plain, 'utf-8'), cipher.final()])
  return Buffer.concat([nonce, enc, cipher.getAuthTag()]).toString('base64')
}

function aesDecrypt(encB64: string): string | null {
  try {
    const raw = Buffer.from(encB64, 'base64')
    const nonce = raw.subarray(0, 12)
    const tag = raw.subarray(raw.length - 16)
    const data = raw.subarray(12, raw.length - 16)
    const decipher = crypto.createDecipheriv('aes-256-gcm', tokenKey(), nonce)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf-8')
  } catch {
    return null
  }
}

// ---------- 网络（undici + SOCKS5） ----------

/** 规则串 → 调度器缓存（同一规则复用连接池） */
const dispatcherCache = new Map<string, Dispatcher | undefined>()

function parseRules(rules: string): { kind: 'http' | 'socks5'; host: string; port: number } | null {
  const r = rules.trim()
  if (r.startsWith('socks5://')) {
    const rest = r.slice('socks5://'.length).replace(/\/+$/, '')
    const [host, port] = rest.split(':')
    if (!host || !port) return null
    return { kind: 'socks5', host, port: parseInt(port, 10) }
  }
  // `http=h:p;https=h:p` / `http://h:p`
  const m = r.match(/(?:^|;)(?:https?|all)=(?:https?:\/\/)?([^;:]+):(\d+)/)
  if (m) return { kind: 'http', host: m[1], port: parseInt(m[2], 10) }
  const direct = r.match(/^(?:https?:\/\/)?([^;:]+):(\d+)\/?$/)
  if (direct) return { kind: 'http', host: direct[1], port: parseInt(direct[2], 10) }
  return null
}

/** SOCKS5 调度器：undici connect 钩子里经代理建 TCP，https 再自行包 TLS */
function socksDispatcher(host: string, port: number): Dispatcher {
  return new Agent({
    connect: (opts, callback) => {
      const hostname = (opts as { hostname?: string; host?: string }).hostname || (opts as { host?: string }).host || ''
      SocksClient.createConnection({
        proxy: { host, port, type: 5 },
        command: 'connect',
        destination: { host: hostname, port: Number(opts.port || 443) }
      })
        .then(({ socket }) => {
          if (opts.protocol === 'https:') {
            const tlsSocket = tls.connect({
              socket,
              servername: (opts as { servername?: string }).servername || hostname,
              rejectUnauthorized: true
            })
            tlsSocket.once('secureConnect', () => callback(null, tlsSocket))
            tlsSocket.once('error', (e) => callback(e, null))
          } else {
            callback(null, socket)
          }
        })
        .catch((e) => callback(e as Error, null))
    }
  })
}

function dispatcherForRules(rules: string): Dispatcher | undefined {
  if (dispatcherCache.has(rules)) return dispatcherCache.get(rules)
  const parsed = parseRules(rules)
  let d: Dispatcher | undefined
  if (parsed?.kind === 'http') d = new ProxyAgent(`http://${parsed.host}:${parsed.port}`)
  else if (parsed?.kind === 'socks5') d = socksDispatcher(parsed.host, parsed.port)
  dispatcherCache.set(rules, d)
  return d
}

/** system 模式：读环境变量 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY（Linux 惯例） */
function envProxyRules(): string | null {
  const v = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy
  return v ? v.trim() : null
}

let currentDispatcher: Dispatcher | undefined

async function applyProxy(conf: ProxyConfig): Promise<void> {
  if (conf.mode === 'direct') {
    currentDispatcher = undefined
  } else if (conf.mode === 'system') {
    const rules = envProxyRules()
    currentDispatcher = rules ? dispatcherForRules(rules) : undefined
    logger.info('系统代理模式', rules ? `使用环境变量代理 ${rules}` : '未发现代理环境变量，直连')
  } else {
    currentDispatcher = dispatcherForRules(conf.proxyRules || '')
  }
}

async function platformFetch(url: string, init: FetchInit): Promise<Response> {
  const initAny = { ...init, dispatcher: currentDispatcher } as Record<string, unknown>
  if (!currentDispatcher) delete initAny.dispatcher
  return undiciFetch(url, initAny as Parameters<typeof undiciFetch>[1]) as unknown as Response
}

async function fetchViaProxy(rules: string | null, url: string, init: FetchInit): Promise<Response> {
  const d = rules ? dispatcherForRules(rules) : currentDispatcher
  const initAny = { ...init, dispatcher: d } as Record<string, unknown>
  if (!d) delete initAny.dispatcher
  return undiciFetch(url, initAny as Parameters<typeof undiciFetch>[1]) as unknown as Response
}

/** 探测本机常见代理端口（连接被拒=秒失败；有响应即视为可用） */
async function probeLocalProxies(): Promise<string[]> {
  const found: string[] = []
  for (const port of PROBE_PORTS) {
    for (const rules of [`http=127.0.0.1:${port};https=127.0.0.1:${port}`, `socks5://127.0.0.1:${port}`]) {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 2500)
        try {
          const d = dispatcherForRules(rules)
          const res = await undiciFetch('https://github.com', { dispatcher: d, signal: controller.signal } as Parameters<typeof undiciFetch>[1])
          void res.body?.cancel()
          if (res.status > 0) {
            found.push(rules)
            break
          }
        } finally {
          clearTimeout(timer)
        }
      } catch {
        /* 该端口/协议不通，继续探测 */
      }
      if (found.length) break
    }
    if (found.length) break
  }
  return found
}

// ---------- 终端事件渲染（broadcast 的 CLI 形态） ----------

export type BroadcastListener = (channel: string, payload?: unknown) => void

let listener: BroadcastListener | null = null

/** CLI 命令可注入自己的事件渲染（进度条等）；不注入时仅打印备份进度 */
export function setBroadcastListener(l: BroadcastListener | null): void {
  listener = l
}

// ---------- 自更新 ----------

async function applyUpdate(filePath: string, _info: UpdateInfo): Promise<void> {
  let newBin = filePath
  if (filePath.endsWith('.tar.gz') || filePath.endsWith('.tgz')) {
    const dir = path.dirname(filePath)
    const extract = spawn('tar', ['-xzf', filePath, '-C', dir])
    await new Promise<void>((resolve, reject) => {
      extract.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`解压失败（tar 退出码 ${code}）`))))
      extract.on('error', reject)
    })
    const cand = path.join(dir, 'googled')
    await fsp.access(cand)
    // 压缩包内是 googled/ 目录（含 googled 主程序 + README）；若是目录则取其中的主程序
    newBin = fs.statSync(cand).isDirectory() ? path.join(cand, 'googled') : cand
    await fsp.access(newBin)
  }
  const self = process.argv[1] ? fs.realpathSync(process.argv[1]) : null
  if (!self) {
    console.log(`更新包已就绪：${newBin}，请手动替换当前安装的 googled 文件`)
    return
  }
  const tmp = `${self}.new`
  fs.copyFileSync(newBin, tmp)
  try {
    fs.chmodSync(tmp, 0o755)
  } catch {
    /* ignore */
  }
  fs.renameSync(tmp, self) // 原子替换
  console.log(`✅ 已更新到 v${_info.version}（${self}）。正在运行的进程不受影响，下次启动生效。`)
  setTimeout(() => process.exit(0), 300)
}

// ---------- 平台组装 ----------

class LinuxPlatform implements Platform {
  version(): string {
    return currentVersion()
  }
  isPackaged(): boolean {
    return true
  }
  userDataDir(): string {
    fs.mkdirSync(dataDir(), { recursive: true })
    return dataDir()
  }
  downloadsDir(): string {
    return downloadsDir()
  }
  encryptString(plain: string): string | null {
    return aesEncrypt(plain)
  }
  decryptString(enc: string): string | null {
    return aesDecrypt(enc)
  }
  applyProxy = applyProxy
  fetch = platformFetch
  fetchViaProxy = fetchViaProxy
  probeLocalProxies = probeLocalProxies
  pickUpdateAsset(assets: { name: string; browser_download_url: string }[]): { name: string; url: string } | null {
    const asset =
      assets.find((a) => a.name.startsWith('googled-linux') && a.name.endsWith('.tar.gz')) ||
      assets.find((a) => a.name.startsWith('googled-linux') && a.name.endsWith('.mjs'))
    return asset ? { name: asset.name, url: asset.browser_download_url } : null
  }
  applyUpdate = applyUpdate

  broadcast(channel: string, payload?: unknown): void {
    if (listener) {
      listener(channel, payload)
      return
    }
    // 默认仅输出备份进度（后台 daemon 模式的可观测性）
    if (channel === 'backup:progress' && payload && typeof payload === 'object') {
      const p = payload as { id?: string; message?: string }
      if (p.message) console.log(`[备份] ${p.message}`)
    }
  }

  openExternal(url: string): void {
    try {
      const child = spawn('xdg-open', [url], { stdio: 'ignore', detached: true })
      child.unref()
    } catch {
      /* 无桌面环境时忽略，用户手动复制链接 */
    }
  }

  async openAuthWindow(url: string): Promise<void> {
    console.log('\n────────── Google OAuth 授权 ──────────')
    console.log('请在浏览器中打开以下链接完成登录授权：\n')
    console.log(`  ${url}\n`)
    if (!process.env.SSH_TTY && !process.env.SSH_CLIENT) {
      this.openExternal(url)
      console.log('（已尝试调用系统浏览器打开）')
    } else {
      console.log('提示：当前通过 SSH 运行。浏览器无法回调远程主机的 127.0.0.1，请先做端口转发：')
      const m = url.match(/redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A(\d+)/) || url.match(/redirect_uri=http:\/\/127\.0\.0\.1:(\d+)/)
      if (m) console.log(`  ssh -L ${m[1]}:127.0.0.1:${m[1]} <user>@<host>`)
      console.log('或在任意能访问本机 127.0.0.1 的设备上打开链接。')
    }
    console.log('等待授权回调中（5 分钟超时）…\n')
  }
  closeAuthWindow(): void {
    /* CLI 无窗口 */
  }
  async clearAuthSession(): Promise<void> {
    /* CLI 无浏览器会话 */
  }
  async pickFiles(): Promise<string[]> {
    return []
  }
  async pickFolder(): Promise<string | null> {
    return null
  }
  onSettingsApplied(_s: Settings): void {
    /* CLI 无主题/自启动联动（自启动用 systemd，见 googled install-service） */
  }
}

/** CLI 入口最先调用 */
export function initLinuxPlatform(): void {
  setPlatform(new LinuxPlatform())
}
