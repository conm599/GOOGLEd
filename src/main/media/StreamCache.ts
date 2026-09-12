import { authService } from '../auth/AuthService'
import { netClient } from '../net/NetClient'
import { logger } from '../logger'

const CHUNK_SIZE = 4 * 1024 * 1024
const PREFETCH_AHEAD = 2
const MAX_ATTEMPTS = 6
const MAX_CACHE_BYTES = 512 * 1024 * 1024
const CHUNK_READ_TIMEOUT = 60_000

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const backoff = (attempt: number): number => Math.min(8000, 400 * 2 ** (attempt - 1))

interface MediaMeta {
  size: number
  mime: string
}

/**
 * 单个文件的分块流：每个分块独立请求、失败重试（401 强制刷新令牌）、
 * 读取时预取后续分块。上游抖动只影响单个分块，重试后流自动续上，
 * 播放器最多短暂缓冲而不会永久卡死；seek 回看直接命中缓存。
 */
class MediaEntry {
  readonly fileId: string
  private meta: MediaMeta | null = null
  private metaPromise: Promise<MediaMeta> | null = null
  private chunks = new Map<number, Buffer>()
  private inflight = new Map<number, Promise<Buffer>>()
  private lastAccess = Date.now()

  constructor(fileId: string) {
    this.fileId = fileId
  }

  async ensureMeta(): Promise<MediaMeta> {
    if (this.meta) return this.meta
    if (!this.metaPromise) {
      this.metaPromise = this.probe().catch((e) => {
        this.metaPromise = null
        throw e
      })
    }
    return this.metaPromise
  }

  /** 读取 [start..end]（含端点），顺序产出数据 */
  async *iterRange(start: number, end: number): AsyncGenerator<Uint8Array> {
    await this.ensureMeta()
    const first = Math.floor(start / CHUNK_SIZE)
    const last = Math.floor(end / CHUNK_SIZE)
    for (let idx = first; idx <= last; idx++) {
      // 预取跟随消费进度：只超前当前块 1~2 块。开放式 Range 的 last 是文件尾，
      // 预取若按 Range 终点展开会并发拉全文件——必须挂在内层循环里
      for (let p = idx + 1; p <= Math.min(idx + PREFETCH_AHEAD, last); p++) {
        void this.ensureChunk(p).catch(() => {})
      }
      const buf = await this.ensureChunk(idx)
      const from = idx === first ? start - idx * CHUNK_SIZE : 0
      const to = idx === last ? end - idx * CHUNK_SIZE : buf.length - 1
      if (to >= from) yield buf.subarray(from, to + 1)
    }
  }

  private ensureChunk(idx: number): Promise<Buffer> {
    this.lastAccess = Date.now()
    const hit = this.chunks.get(idx)
    if (hit) return Promise.resolve(hit)
    const going = this.inflight.get(idx)
    if (going) return going
    const p = this.downloadChunk(idx).finally(() => this.inflight.delete(idx))
    this.inflight.set(idx, p)
    return p
  }

  private async downloadChunk(idx: number): Promise<Buffer> {
    const { size } = await this.ensureMeta()
    const start = idx * CHUNK_SIZE
    if (start >= size) throw new Error('分块越界')
    const end = Math.min(start + CHUNK_SIZE, size) - 1
    let lastErr: Error | null = new Error('未知错误')
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await this.fetchRange(`bytes=${start}-${end}`)
        if (res.status === 401) {
          logger.info(`gd:// 401，强制刷新令牌重试 ${this.fileId}`)
          await authService.forceRefresh()
          continue
        }
        if (res.status !== 206 && res.status !== 200) {
          const text = await res.text().catch(() => '')
          throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`)
        }
        const buf = Buffer.from(await withTimeout(res.arrayBuffer(), CHUNK_READ_TIMEOUT, res))
        this.chunks.set(idx, buf)
        streamCache.evictIfNeeded()
        logger.info(`gd:// 分块 #${idx} 就绪 ${this.fileId} (${(buf.length / 1024).toFixed(0)}KB)`)
        return buf
      } catch (e) {
        lastErr = e as Error
        logger.warn(`gd:// 分块 #${idx} 第${attempt}次失败 ${this.fileId}`, lastErr.message)
        if (attempt < MAX_ATTEMPTS) await sleep(backoff(attempt))
      }
    }
    throw lastErr ?? new Error('分块下载失败')
  }

  private async probe(): Promise<MediaMeta> {
    let lastErr: Error | null = new Error('未知错误')
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await this.fetchRange('bytes=0-0')
        if (res.status === 401) {
          await authService.forceRefresh()
          continue
        }
        if (res.status !== 206 && res.status !== 200) {
          const text = await res.text().catch(() => '')
          throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`)
        }
        // content-range: "bytes 0-0/123456"
        const total = Number(res.headers.get('content-range')?.split('/')[1])
        await res.arrayBuffer().catch(() => {})
        if (!Number.isFinite(total)) throw new Error('无法从响应获取文件大小')
        const meta = { size: total, mime: res.headers.get('content-type') || 'application/octet-stream' }
        this.meta = meta
        logger.info(`gd:// 元数据就绪 ${this.fileId} (${(total / 1024 / 1024).toFixed(1)}MB, ${meta.mime})`)
        return meta
      } catch (e) {
        lastErr = e as Error
        logger.warn(`gd:// 元数据探测第${attempt}次失败 ${this.fileId}`, lastErr.message)
        if (attempt < MAX_ATTEMPTS) await sleep(backoff(attempt))
      }
    }
    throw lastErr ?? new Error('元数据探测失败')
  }

  private async fetchRange(range: string): Promise<Response> {
    const token = await authService.getAccessToken()
    return netClient.request(
      `https://www.googleapis.com/drive/v3/files/${this.fileId}?alt=media&supportsAllDrives=true`,
      { headers: { authorization: `Bearer ${token}`, range }, timeoutMs: 30_000 }
    )
  }

  lastUsedAt(): number {
    return this.lastAccess
  }

  cachedBytes(): number {
    let n = 0
    for (const b of this.chunks.values()) n += b.length
    return n
  }

  dropChunks(): void {
    this.chunks.clear()
  }
}

/** withTimeout：读取响应体超时则取消底层流，避免上游假死后永久挂起 */
async function withTimeout(p: Promise<ArrayBuffer>, ms: number, res: Response): Promise<ArrayBuffer> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => {
          void res.body?.cancel().catch(() => {})
          rej(new Error('分块读取超时'))
        }, ms)
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

class StreamCache {
  private entries = new Map<string, MediaEntry>()

  get(fileId: string): MediaEntry {
    let e = this.entries.get(fileId)
    if (!e) {
      e = new MediaEntry(fileId)
      this.entries.set(fileId, e)
    }
    return e
  }

  evictIfNeeded(): void {
    let total = 0
    for (const e of this.entries.values()) total += e.cachedBytes()
    if (total <= MAX_CACHE_BYTES) return
    // 最久未使用的文件先淘汰
    const sorted = [...this.entries.values()].sort((a, b) => a.lastUsedAt() - b.lastUsedAt())
    for (const e of sorted) {
      if (total <= MAX_CACHE_BYTES) break
      total -= e.cachedBytes()
      e.dropChunks()
      this.entries.delete(e.fileId)
    }
  }
}

export const streamCache = new StreamCache()
