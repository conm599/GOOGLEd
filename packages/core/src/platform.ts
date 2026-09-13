/**
 * 平台抽象层：core 是纯 Node 代码，所有平台能力（Electron / Linux CLI）由宿主注入。
 * 宿主入口必须在任何 core 模块被实际使用前调用 setPlatform。
 */
import type { Settings, UpdateInfo } from './types'

/** 代理配置（与 Electron setProxy 的子集对齐，win 直接透传，linux 自行解析） */
export interface ProxyConfig {
  mode: 'direct' | 'system' | 'fixed_servers'
  /** fixed_servers 时的规则串，如 `http=127.0.0.1:7890;https=...` 或 `socks5://host:port` */
  proxyRules?: string
}

/** 网络请求初始化参数：@types/node 的 RequestInit 缺 cache 字段，这里补上（运行时 Electron/Node fetch 都支持） */
export type FetchInit = RequestInit & { cache?: string }

export interface Platform {
  /** 应用版本号（win: app.getVersion()；linux: 包内嵌版本） */
  version(): string
  /** 是否为打包安装版（win 用于决定自启动/更新检查；linux 恒 true） */
  isPackaged(): boolean
  /** 配置与数据目录（win: userData；linux: ~/.config/googled 或 $GOOGLED_HOME） */
  userDataDir(): string
  /** 系统下载目录（下载默认落盘处） */
  downloadsDir(): string

  /** token 加密存储：返回 null 表示平台无加密能力（core 会退化为仅本机可读的明文并警告） */
  encryptString(plain: string): string | null
  decryptString(enc: string): string | null

  /** 应用代理设置到全局网络出口（此后 platform.fetch 全部走该通道） */
  applyProxy(conf: ProxyConfig): Promise<void>
  /** 走全局网络出口发起请求（win: Chromium net 栈 + persist:googled 会话；linux: fetch + 调度器） */
  fetch(url: string, init: FetchInit): Promise<Response>
  /** 用指定代理规则发起一次请求；rules=null 表示走主通道（跟随全局代理设置） */
  fetchViaProxy(rules: string | null, url: string, init: FetchInit): Promise<Response>
  /** 探测本机常见代理端口（更新下载多通道用），返回代理规则串列表 */
  probeLocalProxies(): Promise<string[]>

  /** 从 GitHub Release 的资产列表里挑出本平台的更新包（win: Setup exe；linux: CLI 压缩包） */
  pickUpdateAsset(assets: { name: string; browser_download_url: string }[]): { name: string; url: string } | null
  /** 更新包下载完成后落定：win 拉起安装器并退出；linux 原子替换自身二进制 */
  applyUpdate(filePath: string, info: UpdateInfo): Promise<void>

  /** 广播事件（win: 推给所有渲染窗口；linux: 终端进度/日志），channel 与 preload 暴露的事件同名 */
  broadcast(channel: string, payload?: unknown): void
  /** 用系统默认程序打开外部链接 */
  openExternal(url: string): void

  /** OAuth 授权：win 打开内嵌登录窗口；linux 打印链接并尝试系统浏览器 */
  openAuthWindow(url: string): Promise<void>
  closeAuthWindow(): void
  /** 清空登录会话（win: 清登录窗口分区存储；linux: 无会话，no-op） */
  clearAuthSession(): Promise<void>

  /** 选择要上传的文件/文件夹（GUI 专用；CLI 恒返回空 = 取消） */
  pickFiles(title: string): Promise<string[]>
  pickFolder(title: string): Promise<string | null>

  /** 设置保存后/启动时的平台侧联动（win: 原生主题 + 自启动注册表；linux: no-op） */
  onSettingsApplied(s: Settings): void
}

let current: Platform | null = null

export function setPlatform(p: Platform): void {
  current = p
}

export function getPlatform(): Platform {
  if (!current) throw new Error('Platform 未初始化：入口必须先调用 setPlatform()')
  return current
}

/** 仅用于类型检查/测试；运行时请走 getPlatform */
export function hasPlatform(): boolean {
  return current !== null
}
