import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import { BackupStore, type StoredBackup } from './BackupStore'
import { driveClient } from '../drive/DriveClient'
import { transferEngine } from '../transfer/TransferEngine'
import { logger } from '../logger'
import type { BackupTaskStatus, BackupProgress, BackupSchedule } from '../../shared/types'

interface LocalEntry {
  abs: string
  rel: string
  size: number
  mtimeMs: number
}

interface RemoteEntry {
  id: string
  rel: string
  size: number
  isFolder: boolean
}

/** 自动备份默认稳定等待：文件持续无变化满 5 分钟才上传（Xbox 录屏约每 30 秒刷写一次） */
const DEFAULT_QUIET_MINUTES = 5

/**
 * 增量备份管理器：
 * - 绑定本地文件夹 → 云端同名文件夹（根目录自动创建；选盘符根则命名「X盘」）
 * - 增量 = 新增 + 大小/修改时间变化；本地删除默认不动云端
 * - fs.watch 递归监控，变更去抖 5 秒自动备份
 * - 变更文件交给 TransferEngine 上传（断点续传/并发/自动建目录复用）
 */
class BackupManager {
  private tasks = new Map<string, StoredBackup>()
  private watchers = new Map<string, fs.FSWatcher>()
  private debounceTimers = new Map<string, NodeJS.Timeout>()
  private syncing = new Set<string>()
  private store = new BackupStore()
  /** 稳定检测记录：taskId → 相对路径 → 上次观察到的状态及首次观察时间（仅内存，重启后重新观察） */
  private stability = new Map<string, Map<string, { size: number; mtimeMs: number; firstSeenAt: number }>>()
  /** 自动同步失败后的重试定时器：失败不再依赖下一次文件变动，避免等待稳定的文件被卡死 */
  private retryTimers = new Map<string, NodeJS.Timeout>()
  /** 稳定期唤醒定时器：文件被记录后定时复查，无新文件事件也能按期上传 */
  private stabilityTimers = new Map<string, NodeJS.Timeout>()
  /** 定时备份定时器：按任务计划到点执行一次自动备份 */
  private scheduleTimers = new Map<string, NodeJS.Timeout>()
  /** 同步进行中又有新变动的任务：本轮结束后补跑一次，变动绝不静默丢失 */
  private resyncQueued = new Set<string>()

  start(): void {
    for (const t of this.store.load()) {
      this.tasks.set(t.id, t)
      if (t.watch) this.startWatcher(t.id, t.localPath)
      if (t.schedule && t.schedule.mode !== 'off') this.armSchedule(t.id)
    }
    logger.info(`备份管理器启动，恢复 ${this.tasks.size} 个备份任务`)
  }

  list(): BackupTaskStatus[] {
    return [...this.tasks.values()].map((t) => ({
      id: t.id,
      localPath: t.localPath,
      remoteFolderId: t.remoteFolderId,
      remoteName: t.remoteName,
      watch: t.watch,
      quietMinutes: t.quietMinutes ?? DEFAULT_QUIET_MINUTES,
      lastSyncAt: t.lastSyncAt,
      lastSyncCount: t.lastSyncCount,
      lastError: t.lastError,
      syncing: this.syncing.has(t.id),
      localCount: Object.keys(t.files || {}).length,
      pendingCount: this.stability.get(t.id)?.size || 0
    }))
  }

  progress(id: string, phase: BackupProgress['phase'], message: string): void {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('backup:progress', { id, phase, message } satisfies BackupProgress)
    }
  }

  private emit(): void {
    const snapshot = this.list()
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('backup:changed', snapshot)
    }
  }

  /** 云端目标文件夹名：普通文件夹取自身名字；盘符根（D:\）→「D盘」 */
  deriveRemoteName(localPath: string): string {
    const trimmed = localPath.replace(/[\\/]+$/, '')
    const base = path.basename(trimmed)
    if (!base || /^[A-Za-z]:$/.test(base)) return `${base.replace(':', '')}盘`
    return base
  }

  async add(localPath: string, remoteName?: string, parentFolderId = 'root'): Promise<BackupTaskStatus> {
    const stat = await fsp.stat(localPath)
    if (!stat.isDirectory()) throw new Error('请选择文件夹')
    const name = (remoteName || this.deriveRemoteName(localPath)).trim()
    if (!name) throw new Error('备份文件夹名称不能为空')

    // 目标位置复用同名文件夹（在指定父目录下找，找不到才建）
    let remoteFolderId = parentFolderId
    const existing = await driveClient.list({ parentId: parentFolderId, pageSize: 50, trashed: false })
    const hit = existing.files.find((f) => f.name === name && f.mimeType === 'application/vnd.google-apps.folder')
    if (hit) remoteFolderId = hit.id
    else remoteFolderId = (await driveClient.createFolder(name, parentFolderId)).id

    const task: StoredBackup = {
      id: randomUUID(),
      localPath,
      remoteFolderId,
      remoteName: name,
      watch: true,
      lastSyncAt: 0,
      lastSyncCount: 0,
      files: {}
    }
    this.tasks.set(task.id, task)
    this.persist()
    this.startWatcher(task.id, localPath)
    this.emit()
    void this.syncNow(task.id, true) // 创建时的首次备份视为手动触发，直接全量上传
    return this.toStatus(task)
  }

  async remove(id: string): Promise<void> {
    this.stopWatcher(id)
    this.clearRetry(id)
    this.clearStabilityTimer(id)
    this.clearScheduleTimer(id)
    this.tasks.delete(id)
    this.stability.delete(id)
    this.persist()
    this.emit()
  }

  async setWatch(id: string, watch: boolean): Promise<void> {
    const t = this.tasks.get(id)
    if (!t) return
    t.watch = watch
    if (watch) this.startWatcher(id, t.localPath)
    else {
      this.stopWatcher(id)
      this.clearRetry(id)
      this.scheduleStabilityCheck(id) // 若有等待稳定的遗留记录（定时任务产生），仍需按期唤醒
    }
    this.persist()
    this.emit()
  }

  async setQuietMinutes(id: string, minutes: number): Promise<void> {
    const t = this.tasks.get(id)
    if (!t) return
    t.quietMinutes = Math.min(120, Math.max(1, Math.round(minutes) || DEFAULT_QUIET_MINUTES))
    this.persist()
    this.emit()
    this.scheduleStabilityCheck(id) // 时长变化后按新期限重排唤醒
  }

  /** manual=true（手动「立即备份」/新建任务首次备份）跳过稳定检测直接上传；监控触发则等待文件稳定 */
  async syncNow(id: string, manual = false): Promise<{ queued: number; scanned: number }> {
    const t = this.tasks.get(id)
    if (!t) throw new Error('备份任务不存在')
    if (this.syncing.has(id)) return { queued: -1, scanned: -1 }
    this.syncing.add(id)
    this.emit()
    try {
      const result = await this.doSync(t, manual)
      t.lastSyncAt = Date.now()
      t.lastSyncCount = result.queued
      t.lastError = undefined
      this.persist()
      this.clearRetry(id)
      return result
    } catch (e) {
      t.lastError = (e as Error).message
      this.persist()
      logger.error('备份失败', t.remoteName, (e as Error).message)
      // 自动监控模式下安排一次重试：单次网络故障（如 CF Worker 挂起导致请求超时）不应让等待稳定的文件永远卡住
      if (!manual && t.watch) this.scheduleRetry(id)
      throw e
    } finally {
      this.syncing.delete(id)
      this.emit()
      this.scheduleStabilityCheck(id) // 只要还有等待稳定的文件，保证始终有闹钟在
      if (this.resyncQueued.delete(id)) {
        // 同步进行中发生过文件变动：稍候补跑一轮，把中途的变更加进来（若补跑中又变动，会再次入队）
        setTimeout(() => {
          if (this.tasks.has(id) && !this.syncing.has(id)) void this.syncNow(id).catch(() => undefined)
        }, 3000)
      }
    }
  }

  private scheduleRetry(id: string): void {
    this.clearRetry(id)
    this.retryTimers.set(
      id,
      setTimeout(() => {
        this.retryTimers.delete(id)
        const t = this.tasks.get(id)
        if (t?.watch && !this.syncing.has(id)) void this.syncNow(id).catch(() => undefined)
      }, 60000)
    )
  }

  private clearRetry(id: string): void {
    const timer = this.retryTimers.get(id)
    if (timer) clearTimeout(timer)
    this.retryTimers.delete(id)
  }

  /** 到最早的稳定期限时唤醒一次同步（自动监控和定时任务都可能产生等待记录） */
  private scheduleStabilityCheck(id: string): void {
    const old = this.stabilityTimers.get(id)
    if (old) clearTimeout(old)
    this.stabilityTimers.delete(id)
    const t = this.tasks.get(id)
    const recs = this.stability.get(id)
    if (!t || !recs?.size) return
    const quietMs = (t.quietMinutes ?? DEFAULT_QUIET_MINUTES) * 60000
    const earliest = Math.min(...[...recs.values()].map((r) => r.firstSeenAt)) + quietMs
    this.stabilityTimers.set(
      id,
      setTimeout(() => {
        this.stabilityTimers.delete(id)
        // 到期时恰有同步在跑：不能丢弃（否则无人再唤醒），短暂补试；本次同步结束后 finally 也会重排
        if (this.syncing.has(id)) {
          this.stabilityTimers.set(
            id,
            setTimeout(() => {
              this.stabilityTimers.delete(id)
              if (!this.syncing.has(id)) void this.syncNow(id).catch(() => undefined)
            }, 5000)
          )
          return
        }
        void this.syncNow(id).catch(() => undefined)
      }, Math.max(5000, earliest - Date.now() + 2000))
    )
  }

  private clearStabilityTimer(id: string): void {
    const timer = this.stabilityTimers.get(id)
    if (timer) clearTimeout(timer)
    this.stabilityTimers.delete(id)
  }

  async setSchedule(id: string, schedule?: BackupSchedule): Promise<void> {
    const t = this.tasks.get(id)
    if (!t) return
    t.schedule = schedule && schedule.mode !== 'off' ? schedule : undefined
    this.persist()
    this.emit()
    this.armSchedule(id)
  }

  /** 按 daily→当天/次天、interval→整段间隔 计算下次执行时间并排定定时器 */
  private armSchedule(id: string): void {
    const old = this.scheduleTimers.get(id)
    if (old) clearTimeout(old)
    this.scheduleTimers.delete(id)
    const t = this.tasks.get(id)
    const sch = t?.schedule
    if (!t || !sch || sch.mode === 'off') return
    let delay: number
    if (sch.mode === 'interval') {
      // 以执行时刻为基准整段间隔；应用重启后从启动时间重新计时
      delay = Math.max(1, sch.intervalHours ?? 24) * 3600_000
    } else {
      const [h, m] = (sch.time || '09:00').split(':').map((n) => parseInt(n, 10))
      const next = new Date()
      next.setHours(isNaN(h) ? 9 : h, isNaN(m) ? 0 : m, 0, 0)
      if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1)
      delay = next.getTime() - Date.now()
    }
    this.scheduleTimers.set(
      id,
      setTimeout(() => {
        this.scheduleTimers.delete(id)
        if (!this.tasks.has(id)) return
        logger.info(`定时备份触发：${t.remoteName}`)
        void this.syncNow(id)
          .catch(() => undefined)
          .finally(() => this.armSchedule(id))
      }, delay)
    )
  }

  private clearScheduleTimer(id: string): void {
    const timer = this.scheduleTimers.get(id)
    if (timer) clearTimeout(timer)
    this.scheduleTimers.delete(id)
  }

  private async doSync(t: StoredBackup, manual: boolean): Promise<{ queued: number; scanned: number }> {
    this.progress(t.id, 'scanning', '正在扫描本地文件…')
    const local = await this.scanLocal(t.localPath)

    this.progress(t.id, 'scanning', '正在扫描云端文件…')
    const remoteFolders = new Map<string, string>() // relDir → id（含根）
    remoteFolders.set('', t.remoteFolderId)
    const remote = await this.scanRemote(t.remoteFolderId, '', remoteFolders)

    // 差异：本地有、云端没有 或 快照中 size/mtime 变化
    // 云端已有同名文件 → 带上 updateFileId 原地更新内容，不产生重复文件
    const snapshot = t.files || {}
    const pending: (LocalEntry & { updateFileId?: string })[] = []
    for (const entry of local) {
      const snap = snapshot[entry.rel]
      const remoteHit = remote.get(entry.rel)
      const changed = !remoteHit || !snap || snap.size !== entry.size || snap.mtimeMs !== entry.mtimeMs
      if (changed) pending.push({ ...entry, updateFileId: remoteHit?.id })
    }

    // 稳定检测（仅自动备份）：录屏/录像类应用边录边写盘，必须等文件停止变化再上传，否则反复传半截文件浪费流量。
    // 记录每个待传文件的状态；连续 quietMinutes 无变化才放行，仍在变的刷新记录继续等
    const deferred: LocalEntry[] = []
    let upload = pending
    if (!manual && pending.length) {
      const quietMs = (t.quietMinutes ?? DEFAULT_QUIET_MINUTES) * 60000
      const recs = this.stability.get(t.id) ?? new Map()
      this.stability.set(t.id, recs)
      const now = Date.now()
      upload = []
      for (const entry of pending) {
        const rec = recs.get(entry.rel)
        if (rec && rec.size === entry.size && rec.mtimeMs === entry.mtimeMs && now - rec.firstSeenAt >= quietMs) {
          recs.delete(entry.rel)
          upload.push(entry)
        } else {
          // 状态和上次观察一致但还没等够时长 → 保留原首次观察时间；状态变了 → 重新计时
          recs.set(entry.rel, {
            size: entry.size,
            mtimeMs: entry.mtimeMs,
            firstSeenAt: rec && rec.size === entry.size && rec.mtimeMs === entry.mtimeMs ? rec.firstSeenAt : now
          })
          deferred.push(entry)
        }
      }
    } else if (manual) {
      this.stability.delete(t.id)
      this.clearStabilityTimer(t.id)
    }

    // 本地已删除的远端多余文件（默认不删除，仅提示数量）
    const remoteOnly = [...remote.keys()].filter((rel) => !local.some((l) => l.rel === rel)).length

    const deferNote = deferred.length ? `；${deferred.length} 个文件仍在写入，稳定后自动上传` : ''
    if (!upload.length) {
      t.files = Object.fromEntries(local.map((l) => [l.rel, { size: l.size, mtimeMs: l.mtimeMs }]))
      if (deferred.length) this.scheduleStabilityCheck(t.id)
      this.progress(
        t.id,
        'done',
        deferred.length ? `${deferred.length} 个文件仍在写入，等待稳定（${t.quietMinutes ?? DEFAULT_QUIET_MINUTES} 分钟）后自动上传` : `已是最新（云端多余 ${remoteOnly} 项未处理）`
      )
      logger.info(`备份任务 ${t.remoteName}：扫描 ${local.length}，入队 0，等待稳定 ${deferred.length}`)
      this.emit()
      return { queued: 0, scanned: local.length }
    }

    this.progress(t.id, 'uploading', `发现 ${upload.length} 个变更文件，正在入队…${deferNote}`)
    const queued = await transferEngine.addBackupUploads(
      upload.map((p) => ({ abs: p.abs, rel: p.rel, updateFileId: p.updateFileId })),
      t.remoteFolderId,
      remoteFolders
    )
    t.files = Object.fromEntries(local.map((l) => [l.rel, { size: l.size, mtimeMs: l.mtimeMs }]))
    if (deferred.length) this.scheduleStabilityCheck(t.id)
    this.progress(t.id, 'done', `已入队 ${queued} 个文件${deferNote}（云端多余 ${remoteOnly} 项未处理）`)
    logger.info(`备份任务 ${t.remoteName}：扫描 ${local.length}，入队 ${queued}，等待稳定 ${deferred.length}`)
    return { queued, scanned: local.length }
  }

  /** 递归扫描本地文件夹 */
  private async scanLocal(root: string): Promise<LocalEntry[]> {
    const out: LocalEntry[] = []
    const walk = async (dir: string, relBase: string): Promise<void> => {
      let entries: fs.Dirent[]
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const abs = path.join(dir, e.name)
        const rel = relBase ? `${relBase}/${e.name}` : e.name
        if (e.isDirectory()) {
          await walk(abs, rel)
        } else if (e.isFile()) {
          try {
            const st = await fsp.stat(abs)
            out.push({ abs, rel, size: st.size, mtimeMs: st.mtimeMs })
          } catch {
            /* 文件恰好被删，跳过 */
          }
        }
      }
    }
    await walk(root, '')
    return out
  }

  /** 递归扫描云端文件夹；顺带填充 relDir → folderId 映射供增量上传复用目录 */
  private async scanRemote(
    folderId: string,
    relBase: string,
    folders: Map<string, string>
  ): Promise<Map<string, RemoteEntry>> {
    const out = new Map<string, RemoteEntry>()
    const walk = async (parentId: string, relBase: string): Promise<void> => {
      let pageToken: string | undefined
      do {
        const r = await driveClient.list({ parentId, pageSize: 200, trashed: false, pageToken })
        for (const f of r.files) {
          const rel = relBase ? `${relBase}/${f.name}` : f.name
          const isFolder = f.mimeType === 'application/vnd.google-apps.folder'
          if (isFolder) {
            folders.set(rel, f.id)
            await walk(f.id, rel)
          } else {
            out.set(rel, { id: f.id, rel, size: f.size ? parseInt(f.size, 10) : 0, isFolder })
          }
        }
        pageToken = r.nextPageToken
      } while (pageToken)
    }
    await walk(folderId, relBase)
    return out
  }

  private startWatcher(id: string, localPath: string): void {
    if (this.watchers.has(id)) return
    try {
      const watcher = fs.watch(localPath, { recursive: true }, () => {
        // 去抖 5 秒：编辑器保存/复制大文件会产生连续事件。
        // 有文件在等稳定检测时，把扫描推迟到最近的稳定期限，避免录屏类应用每 30 秒写盘触发高频云端扫描
        const t = this.tasks.get(id)
        const recs = this.stability.get(id)
        let delay = 5000
        if (t && recs?.size) {
          const quietMs = (t.quietMinutes ?? DEFAULT_QUIET_MINUTES) * 60000
          const earliest = Math.min(...[...recs.values()].map((r) => r.firstSeenAt)) + quietMs
          delay = Math.max(delay, earliest - Date.now())
        }
        const old = this.debounceTimers.get(id)
        if (old) clearTimeout(old)
        this.debounceTimers.set(
          id,
          setTimeout(() => {
            this.debounceTimers.delete(id)
            if (this.syncing.has(id)) {
              // 同步进行中：不能丢掉这次变动，标记脏位，本轮结束后补跑
              this.resyncQueued.add(id)
              return
            }
            void this.syncNow(id).catch(() => undefined)
          }, delay)
        )
      })
      this.watchers.set(id, watcher)
    } catch (e) {
      logger.warn('备份监控启动失败', localPath, (e as Error).message)
    }
  }

  private stopWatcher(id: string): void {
    this.watchers.get(id)?.close()
    this.watchers.delete(id)
    const timer = this.debounceTimers.get(id)
    if (timer) clearTimeout(timer)
    this.debounceTimers.delete(id)
  }

  private persist(): void {
    this.store.save([...this.tasks.values()])
  }

  private toStatus(t: StoredBackup): BackupTaskStatus {
    return {
      ...t,
      quietMinutes: t.quietMinutes ?? DEFAULT_QUIET_MINUTES,
      syncing: this.syncing.has(t.id),
      localCount: Object.keys(t.files || {}).length,
      pendingCount: this.stability.get(t.id)?.size || 0
    }
  }
}

export const backupManager = new BackupManager()
