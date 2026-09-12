import { BrowserWindow, dialog } from 'electron'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { TaskStore } from './taskStore'
import { UploadTask } from './UploadTask'
import { DownloadTask } from './DownloadTask'
import { loadSettings } from '../settings'
import { driveClient, FOLDER_MIME } from '../drive/DriveClient'
import { logger } from '../logger'
import type { DriveFile, TransferTask } from '../../shared/types'

/** 速度滑动窗口：窗口太短时，分块未完成期间算出的增量恒为 0 */
const SPEED_WINDOW_MS = 10000
const SPEED_MAX_WINDOW_MS = 60000

/** Google 在线文档没有实体文件，下载时通过 export 端点转换成对应格式 */
const GOOGLE_EXPORTS: Record<string, { mime: string; ext: string }> = {
  'application/vnd.google-apps.document': { mime: 'application/pdf', ext: '.pdf' },
  'application/vnd.google-apps.spreadsheet': {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ext: '.xlsx'
  },
  'application/vnd.google-apps.presentation': {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ext: '.pptx'
  },
  'application/vnd.google-apps.drawing': { mime: 'image/png', ext: '.png' },
  'application/vnd.google-apps.form': { mime: 'application/zip', ext: '.zip' }
}

/**
 * 传输调度器：
 * - 并发控制（settings.concurrency）
 * - 任务状态机 queued → running → done/paused/error
 * - 进度/速度推送 renderer；持久化由 taskStore 完成（崩溃恢复断点）
 */
class TransferEngine {
  private tasks = new Map<string, TransferTask>()
  private controllers = new Map<string, AbortController>()
  private store = new TaskStore()
  private persistTimer: NodeJS.Timeout | null = null
  /** 每任务速度采样（每秒一点）：上传进度按分块跳变，测速必须用滑动窗口平均而非 1 秒差分 */
  private speedSamples = new Map<string, { at: number; bytes: number }[]>()
  private speedTimer: NodeJS.Timeout | null = null

  start(): void {
    const saved = this.store.load()
    for (const t of saved) {
      // 上次运行中的任务恢复为「暂停」，断点信息保留
      if (t.status === 'running' || t.status === 'queued') t.status = 'paused'
      if (t.kind === 'download' && (t.transferred > 0 || t.status === 'paused')) {
        const dt = new DownloadTask(t)
        void dt.reconcileFromDisk().then(() => this.emit(true))
      }
      this.tasks.set(t.id, t)
    }
    this.speedTimer = setInterval(() => this.tickSpeed(), 1000)
    logger.info(`传输引擎启动，恢复 ${this.tasks.size} 个任务`)
    this.emit()
  }

  list(): TransferTask[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  /** 活动/排队/暂停中的下载任务正在使用的 .part 断点文件（缓存清理必须跳过这些） */
  activePartPaths(): Set<string> {
    const out = new Set<string>()
    for (const t of this.tasks.values()) {
      if (t.kind === 'download' && (t.status === 'running' || t.status === 'paused' || t.status === 'queued')) {
        out.add(t.localPath + '.part')
      }
    }
    return out
  }

  /** 选择文件加入上传队列 */
  async addUploadFiles(parentId: string): Promise<number> {
    const win = BrowserWindow.getAllWindows()[0]
    const result = await dialog.showOpenDialog(win, {
      title: '选择要上传的文件',
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || !result.filePaths.length) return 0
    let count = 0
    for (const p of result.filePaths) count += await this.addUploadPath(p, parentId)
    this.emit(true)
    return count
  }

  /** 选择文件夹加入上传队列（递归展开，云端目录结构自动创建） */
  async addUploadFolder(parentId: string): Promise<number> {
    const win = BrowserWindow.getAllWindows()[0]
    const result = await dialog.showOpenDialog(win, {
      title: '选择要上传的文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths.length) return 0
    const count = await this.addUploadPath(result.filePaths[0], parentId)
    this.emit(true)
    return count
  }

  async addUploadsFromPaths(paths: string[], parentId: string): Promise<number> {
    let count = 0
    for (const p of paths) count += await this.addUploadPath(p, parentId)
    this.emit(true)
    return count
  }

  /**
   * 备份专用：按相对路径上传并复用云端已有目录。
   * folderCache 由调用方提供（relDir → folderId，含根目录映射），云端已存在的目录直接命中不重建。
   */
  async addBackupUploads(
    files: { abs: string; rel: string; updateFileId?: string }[],
    remoteFolderId: string,
    folderCache: Map<string, string>
  ): Promise<number> {
    const ensureDir = async (relDir: string): Promise<string> => {
      const cached = folderCache.get(relDir)
      if (cached) return cached
      const parentRel = relDir.includes('/') ? relDir.slice(0, relDir.lastIndexOf('/')) : ''
      const parent = await ensureDir(parentRel)
      const name = relDir.slice(relDir.lastIndexOf('/') + 1)
      const folder = await driveClient.createFolder(name, parent)
      folderCache.set(relDir, folder.id)
      return folder.id
    }
    let count = 0
    // 排队/上传中/暂停的同路径任务视为「在途」：备份监控会在大文件上传期间反复触发同步，
    // 远端此时还查不到这些文件，不去重会重复入队并在云端产生多个副本
    const inFlight = new Set<string>()
    for (const t of this.tasks.values()) {
      if (t.kind === 'upload' && (t.status === 'queued' || t.status === 'running' || t.status === 'paused')) {
        inFlight.add(`${t.localPath}|${t.parentId}`)
      }
    }
    for (const f of files) {
      try {
        const relDir = f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : ''
        const targetId = await ensureDir(relDir)
        const key = `${f.abs}|${targetId}`
        if (inFlight.has(key)) continue
        inFlight.add(key)
        count += await this.addUploadPath(f.abs, targetId, f.updateFileId)
      } catch (e) {
        logger.warn('备份入队失败', f.rel, (e as Error).message)
      }
    }
    this.emit(true)
    return count
  }

  private async addUploadPath(p: string, parentId: string, updateFileId?: string): Promise<number> {
    const stat = await fsp.stat(p)
    if (stat.isDirectory()) {
      // 递归：先建云端文件夹，再上传其中内容
      const name = path.basename(p)
      const folder = await driveClient.createFolder(name, parentId)
      const entries = await fsp.readdir(p)
      let count = 0
      for (const e of entries) {
        count += await this.addUploadPath(path.join(p, e), folder.id)
      }
      if (!count) {
        // 空文件夹也占位成功，直接返回
      }
      return count
    }
    const task: TransferTask = {
      id: randomUUID(),
      kind: 'upload',
      localPath: p,
      fileName: path.basename(p),
      parentId,
      mimeType: guessMime(p),
      size: stat.size,
      transferred: 0,
      status: 'queued',
      updateFileId,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    this.tasks.set(task.id, task)
    this.persistSoon()
    this.pump()
    return 1
  }

  async addDownload(file: DriveFile, destDir?: string): Promise<number> {
    const dir = destDir || loadSettings().downloadDir
    if (!dir) throw new Error('请先在设置中选择下载目录')
    await fsp.mkdir(dir, { recursive: true })
    // Google 在线文档（Docs/Sheets 等）没有 size，走 export 转格式下载
    const ex = GOOGLE_EXPORTS[file.mimeType]
    let localName = file.name
    if (ex && !/\.[a-z0-9]{2,5}$/i.test(localName)) localName += ex.ext
    const task: TransferTask = {
      id: randomUUID(),
      kind: 'download',
      localPath: path.join(dir, localName),
      fileName: file.name,
      remoteId: file.id,
      mimeType: file.mimeType,
      size: file.size ? parseInt(file.size, 10) : 0,
      transferred: 0,
      status: 'queued',
      exportMime: ex?.mime,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    // 任务必须立刻入队（任何网络元数据补全都放到 DownloadTask.run 里，失败走任务自己的错误通道）
    this.tasks.set(task.id, task)
    this.persistSoon()
    this.pump()
    this.emit(true)
    return 1
  }

  pause(id: string): void {
    const t = this.tasks.get(id)
    if (!t || t.status !== 'running') return
    this.controllers.get(id)?.abort()
    t.status = 'paused'
    t.updatedAt = Date.now()
    this.emit(true)
  }

  resume(id: string): void {
    const t = this.tasks.get(id)
    if (!t || (t.status !== 'paused' && t.status !== 'error' && t.status !== 'canceled')) return
    t.status = 'queued'
    t.error = undefined
    t.updatedAt = Date.now()
    this.persistSoon()
    this.pump()
    this.emit(true)
  }

  cancel(id: string): void {
    const t = this.tasks.get(id)
    if (!t) return
    if (t.status === 'running') this.controllers.get(id)?.abort()
    t.status = 'canceled'
    t.updatedAt = Date.now()
    this.persistSoon()
    this.pump()
    this.emit(true)
  }

  async remove(id: string): Promise<void> {
    const t = this.tasks.get(id)
    if (!t) return
    if (t.status === 'running') this.controllers.get(id)?.abort()
    if (t.kind === 'download') {
      const dt = new DownloadTask(t)
      await dt.clearPart().catch(() => undefined)
    }
    this.tasks.delete(id)
    this.persistSoon()
    this.emit(true)
  }

  clearFinished(): void {
    for (const [id, t] of this.tasks) {
      if (t.status === 'done' || t.status === 'canceled') this.tasks.delete(id)
    }
    this.persistSoon()
    this.emit(true)
  }

  /** 清除所有任务：中断进行中的（上传/下载/排队全部移除，断点文件一并清理） */
  async clearAll(): Promise<void> {
    for (const [id, t] of [...this.tasks]) {
      if (t.status === 'running') this.controllers.get(id)?.abort()
      if (t.kind === 'download') {
        const dt = new DownloadTask(t)
        await dt.clearPart().catch(() => undefined)
      }
      this.tasks.delete(id)
      this.controllers.delete(id)
    }
    this.persistSoon()
    this.emit(true)
  }

  /** 按并发数补位启动队列任务 */
  private pump(): void {
    const max = Math.max(1, loadSettings().concurrency)
    const running = [...this.tasks.values()].filter((t) => t.status === 'running').length
    let slots = max - running
    if (slots <= 0) return
    for (const t of this.tasks.values()) {
      if (slots <= 0) break
      if (t.status === 'queued') {
        slots--
        void this.runTask(t)
      }
    }
  }

  private async runTask(t: TransferTask): Promise<void> {
    t.status = 'running'
    t.error = undefined
    t.updatedAt = Date.now()
    const controller = new AbortController()
    this.controllers.set(t.id, controller)
    this.speedSamples.delete(t.id) // 每次起跑重新开窗口
    this.emit()

    const onProgress = (bytes: number) => {
      if (t.status !== 'running') return
      t.transferred = bytes
      t.updatedAt = Date.now()
    }
    const onMeta = (patch: Partial<TransferTask>) => {
      Object.assign(t, patch)
      this.persistSoon()
    }

    try {
      if (t.kind === 'upload') {
        if (t.updateFileId) t.remoteId = t.updateFileId // 更新模式：核对的就是被更新的那个文件
        await new UploadTask(t).run(controller.signal, onProgress, onMeta)
        // 上传完成后向远端核对；0 字节文件等场景可能拿不到远端 id（文件其实已创建），跳过核对
        if (t.remoteId) {
          const meta = await driveClient.get(t.remoteId, 'id,size')
          const remoteSize = meta.size ? parseInt(meta.size, 10) : -1
          if (t.size > 0 && remoteSize !== t.size) throw new Error(`上传校验失败：远端 ${remoteSize} / 本地 ${t.size} 字节`)
        }
        // 新版校验通过，被替换的旧版（在回收站）此刻才彻底删除
        if (t.replacedOldId) {
          const oldId = t.replacedOldId
          delete t.replacedOldId
          await driveClient.deleteForever(oldId).catch((e) => logger.warn('旧版本彻底删除失败（保留在回收站）', oldId, (e as Error).message))
          this.persistSoon()
        }
      } else {
        await new DownloadTask(t).run(controller.signal, onProgress)
      }
      t.transferred = t.size
      t.status = 'done'
      logger.info('任务完成', t.kind, t.fileName)
    } catch (e) {
      const err = e as Error
      if (err.name === 'AbortError' || controller.signal.aborted) {
        // 用户取消（cancel 先置 canceled 再 abort）不能被覆盖成暂停；
        // cur 用宽类型承接：TS 不知道 cancel() 会在 abort 前从外部把状态改成 canceled
        const cur: string = t.status
        if (cur !== 'canceled') t.status = 'paused'
      } else {
        t.status = 'error'
        t.error = err.message
        logger.error('任务失败', t.fileName, err.message)
      }
    } finally {
      this.controllers.delete(t.id)
      t.updatedAt = Date.now()
      this.persistSoon()
      this.emit()
      this.pump()
    }
  }

  private tickSpeed(): void {
    const now = Date.now()
    let changed = false
    for (const t of this.tasks.values()) {
      if (t.status !== 'running') {
        this.speedSamples.delete(t.id)
        continue
      }
      const samples = this.speedSamples.get(t.id) ?? []
      samples.push({ at: now, bytes: t.transferred })
      while (samples.length > 2 && now - samples[0].at > SPEED_MAX_WINDOW_MS) samples.shift()
      this.speedSamples.set(t.id, samples)
      // 常规取最近 10 秒平均速率；若窗口内进度没动（大分块还没传完），
      // 回溯到最近一次进度变化点再平均，保证分块上传期间始终有速度读数
      let b = samples.findIndex((s) => now - s.at <= SPEED_WINDOW_MS)
      if (b < 0) b = samples.length - 1
      while (b > 0 && samples[b].bytes >= t.transferred) b--
      const dt = (now - samples[b].at) / 1000
      t.speed = dt > 0 ? Math.max(0, (t.transferred - samples[b].bytes) / dt) : 0
      changed = true
    }
    if (changed) this.emit()
  }

  private persistSoon(): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.store.save(this.list())
    }, 800)
  }

  private emitTimer: NodeJS.Timeout | null = null
  private lastEmitAt = 0

  /**
   * 推送任务快照。任务量大时全量克隆 + IPC 推送很贵（几万任务每秒一推会把主进程和渲染层一起拖死），
   * 按任务量自适应限频（1s/3s/5s），尾沿定时器保证最终状态一定送达。
   * force 用于用户主动操作（暂停/取消/清除等），跳过限频立即推送。
   */
  private emit(force = false): void {
    if (!force) {
      const size = this.tasks.size
      const minInterval = size > 20000 ? 5000 : size > 5000 ? 3000 : 1000
      const elapsed = Date.now() - this.lastEmitAt
      if (elapsed < minInterval) {
        this.emitTimer ??= setTimeout(() => {
          this.emitTimer = null
          this.emit(true)
        }, minInterval - elapsed)
        return
      }
    }
    if (this.emitTimer) {
      clearTimeout(this.emitTimer)
      this.emitTimer = null
    }
    this.lastEmitAt = Date.now()
    const snapshot = this.list().map((t) => ({ ...t, sessionUri: undefined }))
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('transfer:changed', snapshot)
    }
  }
}

function guessMime(p: string): string {
  const ext = path.extname(p).toLowerCase()
  const map: Record<string, string> = {
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'text/javascript',
    '.ts': 'text/typescript',
    '.json': 'application/json',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.7z': 'application/x-7z-compressed',
    '.rar': 'application/vnd.rar',
    '.gz': 'application/gzip',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.mp3': 'audio/mpeg',
    '.flac': 'audio/flac',
    '.wav': 'audio/wav',
    '.mp4': 'video/mp4',
    '.mkv': 'video/x-matroska',
    '.mov': 'video/quicktime',
    '.doc': 'application/msword',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ppt': 'application/vnd.ms-powerpoint',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.exe': 'application/vnd.microsoft.portable-executable',
    '.apk': 'application/vnd.android.package-archive',
    '.iso': 'application/x-iso9660-image'
  }
  return map[ext] || 'application/octet-stream'
}

export const transferEngine = new TransferEngine()
export { FOLDER_MIME }
