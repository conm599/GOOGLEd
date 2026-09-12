import { ipcMain, BrowserWindow, dialog, shell, webUtils } from 'electron'
import * as fs from 'node:fs'
import { loadSettings, saveSettings, applyAutoStart } from './settings'
import { netClient } from './net/NetClient'
import { authService } from './auth/AuthService'
import { driveClient } from './drive/DriveClient'
import { transferEngine } from './transfer/TransferEngine'
import { backupManager } from './backup/BackupManager'
import type { BackupSchedule } from '../shared/types'
import { workerTemplate } from './net/workerTemplate'
import * as diskCache from './storage/DiskCache'
import { logger } from './logger'

/** 缩略图 LRU 缓存：fileId → dataURL */
const thumbCache = new Map<string, string>()
const THUMB_MAX = 300

export function registerIpc(): void {
  // ---- 设置 / 网络 ----
  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('settings:update', async (_e, patch: Record<string, unknown>) => {
    const s = { ...loadSettings(), ...patch }
    saveSettings(s)
    await netClient.applySettings(s)
    applyAutoStart(s)
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings:changed', s)
    // 阈值改动后立即评估一次自动清理
    void diskCache.maybeAutoClean()
    return s
  })
  ipcMain.handle('settings:testWorker', async () => {
    const s = loadSettings()
    if (!s.workerBase) return { ok: false, message: '请先填写 Workers 地址' }
    const start = Date.now()
    try {
      // 未带 token 的请求会得到 401，但能证明链路（DNS→CF→Google）是通的
      const res = await netClient.request('https://www.googleapis.com/drive/v3/about?fields=user', {
        timeoutMs: 15000
      })
      const ms = Date.now() - start
      if (res.status === 401 || res.status === 403 || res.status === 200) {
        return { ok: true, message: `链路通畅（HTTP ${res.status}）`, latencyMs: ms }
      }
      return { ok: false, message: `异常响应 HTTP ${res.status}`, latencyMs: ms }
    } catch (e) {
      return { ok: false, message: `连接失败：${(e as Error).message.slice(0, 120)}` }
    }
  })
  ipcMain.handle('settings:workerTemplate', () => workerTemplate)

  /** 一键导入 Google 控制台「下载 JSON」得到的 OAuth 客户端凭据文件 */
  ipcMain.handle('settings:importClientJson', async () => {
    const win = BrowserWindow.getAllWindows()[0]
    const r = await dialog.showOpenDialog(win, {
      title: '选择 Google 下载的客户端 JSON 文件',
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (r.canceled || !r.filePaths[0]) return { ok: false, message: '已取消' }
    try {
      const raw = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf-8')) as {
        installed?: { client_id?: string; client_secret?: string; project_id?: string }
        web?: { client_id?: string; client_secret?: string; project_id?: string }
      }
      const section = raw.installed || raw.web
      if (!section?.client_id || !section?.client_secret) {
        return { ok: false, message: '这个 JSON 里没有 client_id/client_secret——请确认创建时应用类型选了「桌面应用」' }
      }
      const s = { ...loadSettings(), clientId: section.client_id, clientSecret: section.client_secret }
      saveSettings(s)
      return { ok: true, message: `导入成功（项目：${section.project_id ?? '未知'}）` }
    } catch (e) {
      return { ok: false, message: '文件解析失败：' + (e as Error).message }
    }
  })

  // ---- 账号 ----
  ipcMain.handle('auth:status', () => authService.status())
  ipcMain.handle('auth:login', async () => {
    await authService.login()
    return authService.status()
  })
  ipcMain.handle('auth:logout', async () => {
    await authService.logout()
    return authService.status()
  })
  ipcMain.handle('auth:relogin', async () => {
    await authService.relogin()
    return authService.status()
  })

  // ---- 文件 ----
  ipcMain.handle('drive:list', (_e, opts) => driveClient.list(opts))
  ipcMain.handle('drive:listShared', (e) =>
    driveClient.listShared((scanned, shared) => {
      if (!e.sender.isDestroyed()) e.sender.send('share:progress', { scanned, shared })
    })
  )
  ipcMain.handle('drive:listTrash', () => driveClient.listTrash())
  ipcMain.handle('drive:search', (_e, rootId: string, query: string) => driveClient.searchInFolder(rootId, query))
  ipcMain.handle('drive:createFolder', (_e, name: string, parentId: string) => driveClient.createFolder(name, parentId))
  ipcMain.handle('drive:copy', (_e, fileId: string, parentId: string) => driveClient.copy(fileId, parentId))
  ipcMain.handle(
    'drive:copyFolder',
    (_e, folderId: string, name: string, parentId: string) => {
      let last = 0
      return driveClient.copyFolderRecursive(folderId, name, parentId, (done, total) => {
        if (done % 5 === 0 || done === total) {
          if (Date.now() - last > 400) {
            last = Date.now()
            for (const w of BrowserWindow.getAllWindows()) {
              if (!w.isDestroyed()) w.webContents.send('copy:progress', { done, total })
            }
          }
        }
      })
    }
  )
  ipcMain.handle('drive:rename', (_e, id: string, name: string) => driveClient.rename(id, name))
  ipcMain.handle('drive:move', (_e, id: string, addParent: string, removeParent: string) =>
    driveClient.move(id, addParent, removeParent)
  )
  ipcMain.handle('drive:trash', (_e, id: string) => driveClient.trash(id))
  ipcMain.handle('drive:untrash', (_e, id: string) => driveClient.untrash(id))
  ipcMain.handle('drive:deleteForever', (_e, id: string) => driveClient.deleteForever(id))
  ipcMain.handle('drive:emptyTrash', (e) => {
    let last = 0
    return driveClient.emptyTrash((done, total) => {
      if (Date.now() - last > 300) {
        last = Date.now()
        if (!e.sender.isDestroyed()) e.sender.send('trash:progress', { done, total })
      }
    })
  })
  ipcMain.handle('drive:about', () => driveClient.about())

  // ---- 预览 ----
  const FILE_ID_RE = /^[A-Za-z0-9_-]{10,64}$/
  ipcMain.handle('drive:readText', async (_e, fileId: string) => {
    if (!FILE_ID_RE.test(fileId)) throw new Error('非法文件 ID')
    const token = await authService.getAccessToken()
    const res = await netClient.request(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
      { headers: { authorization: `Bearer ${token}` }, timeoutMs: 30000 }
    )
    if (!res.ok) throw new Error(`读取失败（HTTP ${res.status}）`)
    const buf = await res.arrayBuffer()
    if (buf.byteLength > 2 * 1024 * 1024) throw new Error('文件超过 2MB，请下载后查看')
    return new TextDecoder('utf-8').decode(buf)
  })

  // ---- 分享 ----
  ipcMain.handle('share:listPermissions', (_e, id: string) => driveClient.listPermissions(id))
  ipcMain.handle('share:createLink', (_e, id: string, role: 'reader' | 'writer') => driveClient.createAnyoneLink(id, role))
  ipcMain.handle('share:deletePermission', (_e, id: string, permId: string) => driveClient.deletePermission(id, permId))
  ipcMain.handle('share:revoke', async (_e, id: string) => {
    // 找到 anyone 权限并删除 = 取消分享
    const perms = await driveClient.listPermissions(id)
    for (const p of perms) {
      if (p.type === 'anyone') {
        await driveClient.deletePermission(id, p.id)
        return true
      }
    }
    return false
  })

  // ---- 缓存管理 ----
  ipcMain.handle('cache:stats', () => diskCache.stats())
  ipcMain.handle('cache:clear', () => diskCache.clearOrphanParts())

  // ---- 缩略图 ----
  ipcMain.handle('thumb:get', async (_e, fileId: string) => {
    const cached = thumbCache.get(fileId)
    if (cached) return cached
    try {
      const meta = await driveClient.get(fileId, 'id,thumbnailLink')
      if (!meta.thumbnailLink) return ''
      const res = await netClient.request(meta.thumbnailLink, { timeoutMs: 15000 })
      if (!res.ok) return ''
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > 2 * 1024 * 1024) return '' // 太大不缓存
      const type = res.headers.get('content-type') || 'image/jpeg'
      const dataUrl = `data:${type};base64,${buf.toString('base64')}`
      if (thumbCache.size >= THUMB_MAX) {
        const first = thumbCache.keys().next().value
        if (first) thumbCache.delete(first)
      }
      thumbCache.set(fileId, dataUrl)
      return dataUrl
    } catch (e) {
      logger.warn('缩略图获取失败', fileId, (e as Error).message)
      return ''
    }
  })

  // ---- 传输 ----
  ipcMain.handle('transfer:addUploads', (_e, parentId: string) => transferEngine.addUploadFiles(parentId))
  ipcMain.handle('transfer:addUploadFolder', (_e, parentId: string) => transferEngine.addUploadFolder(parentId))
  ipcMain.handle('transfer:addUploadPaths', (_e, paths: string[], parentId: string) =>
    transferEngine.addUploadsFromPaths(paths, parentId)
  )
  ipcMain.handle('transfer:addDownload', (_e, file, destDir?: string) => transferEngine.addDownload(file, destDir))
  ipcMain.handle('transfer:list', () => transferEngine.list())
  ipcMain.handle('transfer:pause', (_e, id: string) => transferEngine.pause(id))
  ipcMain.handle('transfer:resume', (_e, id: string) => transferEngine.resume(id))
  ipcMain.handle('transfer:cancel', (_e, id: string) => transferEngine.cancel(id))
  ipcMain.handle('transfer:remove', (_e, id: string) => transferEngine.remove(id))
  ipcMain.handle('transfer:clearFinished', () => transferEngine.clearFinished())
  ipcMain.handle('transfer:clearAll', () => transferEngine.clearAll())

  // ---- 对话框 / 系统 ----
  ipcMain.handle('dialog:pickDownloadDir', async () => {
    const win = BrowserWindow.getAllWindows()[0]
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] })
    return r.canceled ? '' : r.filePaths[0]
  })
  ipcMain.handle('dialog:pickBackupFolder', async () => {
    const win = BrowserWindow.getAllWindows()[0]
    const r = await dialog.showOpenDialog(win, {
      title: '选择要备份的本地文件夹',
      properties: ['openDirectory']
    })
    if (r.canceled || !r.filePaths[0]) return null
    return { localPath: r.filePaths[0], suggestedName: backupManager.deriveRemoteName(r.filePaths[0]) }
  })

  // ---- 备份 ----
  ipcMain.handle('backup:list', () => backupManager.list())
  ipcMain.handle('backup:add', (_e, localPath: string, remoteName?: string, parentFolderId?: string) =>
    backupManager.add(localPath, remoteName, parentFolderId || 'root')
  )
  ipcMain.handle('backup:remove', (_e, id: string) => backupManager.remove(id))
  ipcMain.handle('backup:setWatch', (_e, id: string, watch: boolean) => backupManager.setWatch(id, watch))
  ipcMain.handle('backup:setQuietMinutes', (_e, id: string, minutes: number) => backupManager.setQuietMinutes(id, minutes))
  ipcMain.handle('backup:setSchedule', (_e, id: string, schedule?: BackupSchedule) => backupManager.setSchedule(id, schedule))
  ipcMain.handle('backup:syncNow', (_e, id: string, manual?: boolean) => backupManager.syncNow(id, manual ?? true))
  ipcMain.handle('app:pathForFile', (_e, file: File) => webUtils.getPathForFile(file))
  ipcMain.handle('app:openPath', (_e, p: string) => shell.openPath(p))
  ipcMain.handle('app:showItemInFolder', (_e, p: string) => {
    shell.showItemInFolder(p)
    return true
  })
  ipcMain.handle('app:openExternal', (_e, url: string) => shell.openExternal(url))

  logger.info('IPC 已注册')
}
