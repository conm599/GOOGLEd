import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DriveFile, Settings, TransferTask, AuthStatus, WorkerTestResult, DrivePermission, UpdateInfo } from '../shared/types'

/**
 * IPC 结构化克隆不接受任何 Proxy——而 Vue reactive 是深层的，
 * { ...row } 展开后嵌套数组（如 parents/workerHosts）读出来仍是 Proxy，invoke 会抛
 * "An object could not be cloned"。这里统一把参数纯化成普通 JSON 数据。
 */
function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

const api = {
  // 设置 / 网络
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke('settings:update', plain(patch)),
  testWorker: (): Promise<WorkerTestResult> => ipcRenderer.invoke('settings:testWorker'),
  importClientJson: (): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('settings:importClientJson'),
  getWorkerTemplate: (): Promise<string> => ipcRenderer.invoke('settings:workerTemplate'),

  // 账号
  authStatus: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:status'),
  login: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:login'),
  logout: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:logout'),
  relogin: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:relogin'),

  // 文件
  driveList: (opts: {
    parentId?: string
    query?: string
    orderBy?: string
    pageToken?: string
    trashed?: boolean
    pageSize?: number
  }): Promise<{
    files: DriveFile[]
    nextPageToken?: string
  }> => ipcRenderer.invoke('drive:list', plain(opts)),
  driveListShared: (): Promise<DriveFile[]> => ipcRenderer.invoke('drive:listShared'),
  onShareProgress: (cb: (p: { scanned: number; shared: number }) => void): (() => void) => {
    const listener = (_e: unknown, p: { scanned: number; shared: number }): void => cb(p)
    ipcRenderer.on('share:progress', listener)
    return () => ipcRenderer.removeListener('share:progress', listener)
  },
  driveListTrash: (): Promise<{ files: DriveFile[] }> => ipcRenderer.invoke('drive:listTrash'),
  driveSearch: (rootId: string, query: string): Promise<{ files: DriveFile[] }> =>
    ipcRenderer.invoke('drive:search', rootId, query),
  createFolder: (name: string, parentId: string): Promise<DriveFile> => ipcRenderer.invoke('drive:createFolder', name, parentId),
  driveCopy: (fileId: string, parentId: string): Promise<DriveFile> => ipcRenderer.invoke('drive:copy', fileId, parentId),
  driveCopyFolder: (folderId: string, name: string, parentId: string): Promise<DriveFile> =>
    ipcRenderer.invoke('drive:copyFolder', folderId, name, parentId),
  rename: (id: string, name: string): Promise<void> => ipcRenderer.invoke('drive:rename', id, name),
  move: (id: string, addParent: string, removeParent: string): Promise<void> =>
    ipcRenderer.invoke('drive:move', id, addParent, removeParent),
  trash: (id: string): Promise<void> => ipcRenderer.invoke('drive:trash', id),
  untrash: (id: string): Promise<void> => ipcRenderer.invoke('drive:untrash', id),
  deleteForever: (id: string): Promise<void> => ipcRenderer.invoke('drive:deleteForever', id),
  emptyTrash: (): Promise<{ deleted: number; failed: number }> => ipcRenderer.invoke('drive:emptyTrash'),
  onTrashProgress: (cb: (p: { done: number; total: number }) => void): (() => void) => {
    const listener = (_e: unknown, p: { done: number; total: number }): void => cb(p)
    ipcRenderer.on('trash:progress', listener)
    return () => ipcRenderer.removeListener('trash:progress', listener)
  },
  driveAbout: (): Promise<{ user?: { displayName?: string; emailAddress?: string }; storageQuota?: { limit?: string; usage?: string; usageInDrive?: string; usageInDriveTrash?: string } }> =>
    ipcRenderer.invoke('drive:about'),
  readText: (fileId: string): Promise<string> => ipcRenderer.invoke('drive:readText', fileId),

  // 备份
  backupList: (): Promise<import('../shared/types').BackupTaskStatus[]> => ipcRenderer.invoke('backup:list'),
  backupAdd: (localPath: string, remoteName?: string, parentFolderId?: string): Promise<void> =>
    ipcRenderer.invoke('backup:add', localPath, remoteName, parentFolderId),
  backupRemove: (id: string): Promise<void> => ipcRenderer.invoke('backup:remove', id),
  backupSetWatch: (id: string, watch: boolean): Promise<void> => ipcRenderer.invoke('backup:setWatch', id, watch),
  backupSyncNow: (id: string, manual = true): Promise<{ queued: number; scanned: number }> =>
    ipcRenderer.invoke('backup:syncNow', id, manual),
  backupSetQuietMinutes: (id: string, minutes: number): Promise<void> =>
    ipcRenderer.invoke('backup:setQuietMinutes', id, minutes),
  backupSetSchedule: (id: string, schedule?: import('../shared/types').BackupSchedule): Promise<void> =>
    ipcRenderer.invoke('backup:setSchedule', id, schedule),
  pickBackupFolder: (): Promise<{ localPath: string; suggestedName: string } | null> =>
    ipcRenderer.invoke('dialog:pickBackupFolder'),
  onBackupChanged: (cb: (tasks: import('../shared/types').BackupTaskStatus[]) => void): (() => void) => {
    const listener = (_e: unknown, t: import('../shared/types').BackupTaskStatus[]): void => cb(t)
    ipcRenderer.on('backup:changed', listener)
    return () => ipcRenderer.removeListener('backup:changed', listener)
  },
  onBackupProgress: (
    cb: (p: import('../shared/types').BackupProgress) => void
  ): (() => void) => {
    const listener = (_e: unknown, p: import('../shared/types').BackupProgress): void => cb(p)
    ipcRenderer.on('backup:progress', listener)
    return () => ipcRenderer.removeListener('backup:progress', listener)
  },

  // 分享
  listPermissions: (id: string): Promise<DrivePermission[]> => ipcRenderer.invoke('share:listPermissions', id),
  createShareLink: (id: string, role: 'reader' | 'writer'): Promise<string> => ipcRenderer.invoke('share:createLink', id, role),
  deletePermission: (id: string, permId: string): Promise<void> => ipcRenderer.invoke('share:deletePermission', id, permId),
  revokeShare: (id: string): Promise<boolean> => ipcRenderer.invoke('share:revoke', id),

  // 缓存管理
  cacheStats: (): Promise<{
    orphanParts: { count: number; bytes: number }
    updateCacheBytes: number
    downloadDirBytes: number
    downloadDir: string
  }> => ipcRenderer.invoke('cache:stats'),
  cacheClear: (): Promise<{ freed: number; count: number }> => ipcRenderer.invoke('cache:clear'),

  // 缩略图
  thumbGet: (fileId: string): Promise<string> => ipcRenderer.invoke('thumb:get', fileId),

  // 传输
  addUploads: (parentId: string): Promise<number> => ipcRenderer.invoke('transfer:addUploads', parentId),
  addUploadFolder: (parentId: string): Promise<number> => ipcRenderer.invoke('transfer:addUploadFolder', parentId),
  addUploadPaths: (paths: string[], parentId: string): Promise<number> =>
    ipcRenderer.invoke('transfer:addUploadPaths', paths, parentId),
  addDownload: (file: DriveFile, destDir?: string): Promise<number> =>
    ipcRenderer.invoke('transfer:addDownload', plain(file), destDir),
  transferList: (): Promise<TransferTask[]> => ipcRenderer.invoke('transfer:list'),
  pauseTask: (id: string): Promise<void> => ipcRenderer.invoke('transfer:pause', id),
  resumeTask: (id: string): Promise<void> => ipcRenderer.invoke('transfer:resume', id),
  cancelTask: (id: string): Promise<void> => ipcRenderer.invoke('transfer:cancel', id),
  removeTask: (id: string): Promise<void> => ipcRenderer.invoke('transfer:remove', id),
  clearFinished: (): Promise<void> => ipcRenderer.invoke('transfer:clearFinished'),
  clearAllTasks: (): Promise<void> => ipcRenderer.invoke('transfer:clearAll'),

  // 更新
  checkUpdate: (): Promise<{ status: 'latest' | 'available' | 'error'; info?: UpdateInfo; error?: string }> =>
    ipcRenderer.invoke('update:check'),
  ignoreUpdate: (version: string): Promise<void> => ipcRenderer.invoke('update:ignore', version),
  startUpdate: (info: UpdateInfo): Promise<void> => ipcRenderer.invoke('update:start', plain(info)),
  onUpdateAvailable: (cb: (info: UpdateInfo) => void): (() => void) => {
    const listener = (_e: unknown, info: UpdateInfo): void => cb(info)
    ipcRenderer.on('update:available', listener)
    return () => ipcRenderer.removeListener('update:available', listener)
  },
  onUpdateProgress: (cb: (p: { received: number; total: number }) => void): (() => void) => {
    const listener = (_e: unknown, p: { received: number; total: number }): void => cb(p)
    ipcRenderer.on('update:progress', listener)
    return () => ipcRenderer.removeListener('update:progress', listener)
  },

  // 系统
  pickDownloadDir: (): Promise<string> => ipcRenderer.invoke('dialog:pickDownloadDir'),
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  appVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  openPath: (p: string): Promise<string> => ipcRenderer.invoke('app:openPath', p),
  showItemInFolder: (p: string): Promise<boolean> => ipcRenderer.invoke('app:showItemInFolder', p),
  openExternal: (url: string): Promise<void> => ipcRenderer.invoke('app:openExternal', url),

  // 事件
  onTransferChanged: (cb: (tasks: TransferTask[]) => void): (() => void) => {
    const listener = (_e: unknown, tasks: TransferTask[]): void => cb(tasks)
    ipcRenderer.on('transfer:changed', listener)
    return () => ipcRenderer.removeListener('transfer:changed', listener)
  },
  onSettingsChanged: (cb: (s: Settings) => void): (() => void) => {
    const listener = (_e: unknown, s: Settings): void => cb(s)
    ipcRenderer.on('settings:changed', listener)
    return () => ipcRenderer.removeListener('settings:changed', listener)
  },
  onAuthChanged: (cb: (s: AuthStatus) => void): (() => void) => {
    const listener = (_e: unknown, s: AuthStatus): void => cb(s)
    ipcRenderer.on('auth:changed', listener)
    return () => ipcRenderer.removeListener('auth:changed', listener)
  }
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
