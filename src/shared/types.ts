/** 网络模式：direct 直连 | system 跟随系统代理 | proxy 自定义代理 | workers Cloudflare Workers 反代 */
export type NetMode = 'direct' | 'system' | 'proxy' | 'workers'

export interface Settings {
  netMode: NetMode
  proxyProtocol: 'http' | 'socks5'
  proxyHost: string
  proxyPort: number
  /** Workers 入口，如 https://xxx.workers.dev （末尾不带斜杠） */
  workerBase: string
  /** 需要走 Workers 反代的 Google 域名 */
  workerHosts: string[]
  /** OAuth 客户端凭据（用户自己的 GCP 项目） */
  clientId: string
  clientSecret: string
  /** 同时传输的任务数 */
  concurrency: number
  /** 上传/下载分块大小（MB，须为 256KB 的倍数） */
  chunkSizeMB: number
  /** 下载默认目录 */
  downloadDir: string
  /** 断点残留缓存超过该 GB 数时自动清理（0 = 关闭） */
  cacheAutoCleanGB: number
  /** 开机自启动（仅打包安装版写系统登录项） */
  autoStart: boolean
  /** 静默自启动：开机后不弹主窗口，直接进系统托盘 */
  autoStartHidden: boolean
  /** 用户点过「忽略这次更新」的版本号，之后不再弹该版本的更新提示 */
  ignoredUpdateVersion?: string
  theme: 'light' | 'dark'
}

/** 一次可用的更新：版本号 + 更新说明 + 安装包下载地址 */
export interface UpdateInfo {
  version: string
  notes: string
  assetUrl: string
  assetName: string
}

export const DEFAULT_SETTINGS: Settings = {
  netMode: 'direct',
  proxyProtocol: 'http',
  proxyHost: '127.0.0.1',
  proxyPort: 7890,
  workerBase: '',
  workerHosts: [
    'www.googleapis.com',
    'oauth2.googleapis.com',
    'accounts.google.com',
    'drive.google.com',
    'lh3.googleusercontent.com'
  ],
  clientId: '',
  clientSecret: '',
  concurrency: 3,
  chunkSizeMB: 16,
  downloadDir: '',
  cacheAutoCleanGB: 0,
  autoStart: false,
  autoStartHidden: false,
  theme: 'light'
}

export interface DriveFile {
  id: string
  name: string
  mimeType: string
  size?: string
  modifiedTime?: string
  parentId?: string
  parents?: string[]
  thumbnailLink?: string
  shared?: boolean
  trashed?: boolean
  starred?: boolean
  headRevisionId?: string
  md5Checksum?: string
}

export interface StorageQuota {
  limit?: string
  usage?: string
  usageInDrive?: string
  usageInDriveTrash?: string
}

export interface DrivePermission {
  id: string
  type: string
  role: string
  emailAddress?: string
  displayName?: string
}

export type TaskStatus = 'queued' | 'running' | 'paused' | 'done' | 'error' | 'canceled'

export interface TransferTask {
  id: string
  kind: 'upload' | 'download'
  localPath: string
  fileName: string
  remoteId?: string
  parentId?: string
  mimeType: string
  size: number
  transferred: number
  status: TaskStatus
  speed?: number
  error?: string
  sessionUri?: string
  etag?: string
  md5?: string
  /** 远端文件的 md5Checksum，下载完成后用于完整性比对 */
  remoteMd5?: string
  /** 设置后走 export 端点转格式下载（Google 在线文档没有实体文件） */
  exportMime?: string
  /** 设置后内容更新到这个已有文件（增量备份修改场景，避免产生重复文件） */
  updateFileId?: string
  createdAt: number
  updatedAt: number
}

export interface AuthUserInfo {
  email?: string
  name?: string
  picture?: string
}

export interface AuthStatus {
  configured: boolean
  loggedIn: boolean
  user?: AuthUserInfo
  /** refresh token 已失效（在 Google 端被撤销或过期），需要重新授权 */
  invalid?: boolean
}

export interface WorkerTestResult {
  ok: boolean
  message: string
  latencyMs?: number
}

/** 增量备份任务 */
export interface BackupTask {
  id: string
  /** 本地源文件夹（绝对路径） */
  localPath: string
  /** 云端目标文件夹 ID */
  remoteFolderId: string
  /** 云端显示名（默认=源文件夹名/盘符名） */
  remoteName: string
  /** 是否自动监控变更 */
  watch: boolean
  /** 自动备份的文件稳定等待分钟数：文件持续无变化达到该时长才上传（防录屏/边写边传），手动备份不受限 */
  quietMinutes?: number
  /** 定时备份：未开启自动监控时按计划自动备份一次 */
  schedule?: BackupSchedule
  lastSyncAt: number
  lastSyncCount: number
  lastError?: string
}

export interface BackupSchedule {
  mode: 'off' | 'interval' | 'daily'
  /** interval 模式：间隔小时数（1-168） */
  intervalHours?: number
  /** daily 模式：每天 HH:mm（本地时间） */
  time?: string
}

/** 列表用运行时状态 */
export interface BackupTaskStatus extends BackupTask {
  syncing: boolean
  /** 本地文件总数（上次扫描） */
  localCount: number
  /** 正在等待稳定的文件数（仍在写入，暂不上传） */
  pendingCount?: number
}

export interface BackupProgress {
  id: string
  phase: 'scanning' | 'uploading' | 'done' | 'error'
  message: string
}
