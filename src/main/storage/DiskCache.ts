import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import * as path from 'node:path'
import { app } from 'electron'
import { loadSettings } from '../settings'
import { transferEngine } from '../transfer/TransferEngine'
import { updateCacheDir, updateCacheFiles } from '../update/UpdateService'
import { logger } from '../logger'

export interface DiskCacheStats {
  /** 孤儿断点文件（不属于任何活动/排队/暂停任务） */
  orphanParts: { count: number; bytes: number }
  /** 已下载的应用更新安装包（同样纳入清理） */
  updateCacheBytes: number
  /** 下载目录总占用（含用户已下载的成品文件，仅展示，不清除） */
  downloadDirBytes: number
  downloadDir: string
}

export function downloadDir(): string {
  const s = loadSettings()
  return s.downloadDir || path.join(app.getPath('downloads'), 'GOOGLEd')
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries: fs.Dirent[]
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) await walk(p, out)
    else out.push(p)
  }
}

async function fileSize(p: string): Promise<number> {
  try {
    return (await fsp.stat(p)).size
  } catch {
    return 0
  }
}

/** 孤儿断点文件：下载目录下所有 .part，排除活动任务正在使用的 */
async function orphanParts(): Promise<{ files: string[]; bytes: number }> {
  const active = transferEngine.activePartPaths()
  const all: string[] = []
  await walk(downloadDir(), all)
  const files = all.filter((f) => f.endsWith('.part') && !active.has(f))
  let bytes = 0
  for (const f of files) bytes += await fileSize(f)
  return { files, bytes }
}

export async function stats(): Promise<DiskCacheStats> {
  const dir = downloadDir()
  const all: string[] = []
  await walk(dir, all)
  const active = transferEngine.activePartPaths()
  let orphanBytes = 0
  let orphanCount = 0
  for (const f of all) {
    if (!f.endsWith('.part') || active.has(f)) continue
    orphanCount++
    orphanBytes += await fileSize(f)
  }
  let downloadDirBytes = 0
  for (const f of all) downloadDirBytes += await fileSize(f)
  let updateCacheBytes = 0
  for (const f of await updateCacheFiles()) updateCacheBytes += await fileSize(path.join(updateCacheDir(), f))
  return {
    orphanParts: { count: orphanCount, bytes: orphanBytes },
    updateCacheBytes,
    downloadDirBytes,
    downloadDir: dir
  }
}

/** 清理缓存：孤儿断点文件 + 已下载的更新安装包（绝不触碰活动任务与已下载成品），返回释放量 */
export async function clearOrphanParts(): Promise<{ freed: number; count: number }> {
  const { files } = await orphanParts()
  const updateFiles = await updateCacheFiles()
  let freed = 0
  let count = 0
  for (const f of [...files, ...updateFiles.map((n) => path.join(updateCacheDir(), n))]) {
    const size = await fileSize(f)
    try {
      await fsp.rm(f, { force: true })
      freed += size
      count++
    } catch {
      /* 文件被占用（如安装器正在运行）则跳过 */
    }
  }
  if (count) logger.info(`已清理缓存 ${count} 个文件，释放 ${(freed / 1024 / 1024).toFixed(1)}MB`)
  return { freed, count }
}

/** 阈值自动清理：设置 cacheAutoCleanGB>0 且（孤儿断点+更新安装包）超阈值时执行（仅清安全项） */
export async function maybeAutoClean(): Promise<boolean> {
  const gb = loadSettings().cacheAutoCleanGB ?? 0
  if (gb <= 0) return false
  const st = await stats()
  if (st.orphanParts.bytes + st.updateCacheBytes < gb * 1024 ** 3) return false
  const r = await clearOrphanParts()
  logger.info(
    `缓存自动清理触发（阈值 ${gb}GB）：释放 ${(r.freed / 1024 / 1024).toFixed(1)}MB / ${r.count} 个文件`
  )
  return true
}
