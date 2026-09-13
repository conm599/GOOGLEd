import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { driveClient } from '@core/drive/DriveClient'
import type { DriveFile } from '@core/types'
import { dataDir } from './platform-node'

// ---------- 输出 ----------

export const isTTY = process.stdout.isTTY === true

/** 与 platform.broadcast 对齐的事件监听签名 */
export type BroadcastListenerLike = (channel: string, payload?: unknown) => void

export function out(msg: string): void {
  console.log(msg)
}

export function die(msg: string, code = 1): never {
  console.error(`错误：${msg}`)
  process.exit(code)
}

export function fmtSize(n: number | string | undefined): string {
  const v = typeof n === 'string' ? parseInt(n, 10) : (n ?? 0)
  if (!v || isNaN(v)) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let x = v
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024
    i++
  }
  return `${x.toFixed(x >= 100 || i === 0 ? 0 : 1)}${units[i]}`
}

export function fmtDate(iso?: string): string {
  if (!iso) return '-'
  return iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z').slice(0, 16)
}

/** 交互式确认（非 TTY 或 --yes 时直接通过） */
export function confirm(msg: string, yesFlag: boolean): boolean {
  if (yesFlag || !isTTY) return true
  process.stdout.write(`${msg} [y/N] `)
  const buf = Buffer.alloc(1)
  try {
    fs.readSync(0, buf, 0, 1, null)
  } catch {
    return false
  }
  const c = buf.toString().trim().toLowerCase()
  return c === 'y' || c === 'yes'
}

// ---------- 单实例锁 ----------

const LOCK_FILE = () => path.join(dataDir(), 'googled.lock')

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** 长任务互斥：同一数据目录同时只允许一个改状态/传文件的进程（防 tasks.json 竞态） */
export function acquireLock(): void {
  const f = LOCK_FILE()
  try {
    const raw = JSON.parse(fs.readFileSync(f, 'utf-8')) as { pid: number }
    if (raw.pid !== process.pid && pidAlive(raw.pid)) {
      die(`另一个 googled 正在运行（pid ${raw.pid}），如确认无残留可删除 ${f}`)
    }
  } catch {
    /* 无锁文件 */
  }
  fs.mkdirSync(path.dirname(f), { recursive: true })
  fs.writeFileSync(f, JSON.stringify({ pid: process.pid, at: Date.now() }))
  const release = (): void => {
    try {
      fs.rmSync(f, { force: true })
    } catch {
      /* ignore */
    }
  }
  process.on('exit', release)
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      release()
      process.exit(130)
    })
  }
}

// ---------- 远程路径解析 ----------

export interface ResolvedEntry {
  id: string
  name: string
  isFolder: boolean
  file?: DriveFile
}

const FOLDER_MIME = 'application/vnd.google-apps.folder'

/**
 * 把「路径 / id:xxx / root / 空串」解析成云端条目。
 * 路径按段逐级列表精确匹配（大小写敏感）；`id:` 前缀直接用原始 id。
 */
export async function resolveEntry(input: string): Promise<ResolvedEntry> {
  const t = (input || '').trim()
  if (!t || t === '/' || t === '.' || t.toLowerCase() === 'root') {
    return { id: 'root', name: '我的云端硬盘', isFolder: true }
  }
  if (t.startsWith('id:')) {
    const file = await driveClient.get(t.slice(3), 'id,name,mimeType,size,modifiedTime,shared')
    return { id: file.id, name: file.name, isFolder: file.mimeType === FOLDER_MIME, file }
  }
  const segments = t.split('/').filter(Boolean)
  let cur: ResolvedEntry = { id: 'root', name: '我的云端硬盘', isFolder: true }
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const r = await driveClient.list({ parentId: cur.id, pageSize: 200, trashed: false })
    const hit = r.files.find((f) => f.name === seg)
    if (!hit) {
      const near = r.files
        .slice(0, 8)
        .map((f) => f.name)
        .join('、')
      throw new Error(`找不到「${segments.slice(0, i + 1).join('/')}」（${cur.name} 下无此项${near ? `；附近有：${near}` : ''}）`)
    }
    cur = { id: hit.id, name: hit.name, isFolder: hit.mimeType === FOLDER_MIME, file: hit }
  }
  return cur
}

/** 解析成文件夹（不是文件夹则报错） */
export async function resolveFolder(input: string): Promise<ResolvedEntry> {
  const e = await resolveEntry(input)
  if (!e.isFolder) throw new Error(`「${e.name}」不是文件夹`)
  return e
}

// ---------- 引擎等待 ----------

export interface SyncSummary {
  done: number
  error: number
  canceled: number
}

/** 轮询等传输队列空闲（上传/下载命令的收尾） */
export function waitForIdle(onIdleCheck?: (remaining: number) => void): Promise<SyncSummary> {
  return new Promise((resolve) => {
    const check = (): void => {
      const tasks = engineList()
      const remaining = tasks.filter((t) => t.status === 'queued' || t.status === 'running').length
      if (remaining > 0) {
        onIdleCheck?.(remaining)
        setTimeout(check, 600)
        return
      }
      resolve({
        done: tasks.filter((t) => t.status === 'done').length,
        error: tasks.filter((t) => t.status === 'error').length,
        canceled: tasks.filter((t) => t.status === 'canceled').length
      })
    }
    check()
  })
}

// 延迟导入避免与 index.ts 循环依赖（index 提供 engineList 快照）
let engineListImpl: () => import('@core/types').TransferTask[] = () => []
export function setEngineListImpl(f: () => import('@core/types').TransferTask[]): void {
  engineListImpl = f
}
function engineList(): import('@core/types').TransferTask[] {
  return engineListImpl()
}

/** 优雅退出：给 taskStore 的合并写（800ms 去抖）留出落盘时间 */
export function exitSoon(code = 0): void {
  setTimeout(() => process.exit(code), 1300)
}

export function homeExpand(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : path.resolve(p)
}
