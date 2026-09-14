import * as fsp from 'node:fs/promises'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { netClient } from '../net/NetClient'
import { authService } from '../auth/AuthService'
import { driveClient } from '../drive/DriveClient'
import { logger } from '../logger'
import type { TransferTask } from '../types'

/**
 * HTTP Range 断点下载：
 * - .part 临时文件 + 服务器 Range 请求，从中断字节继续
 * - sidecar 元数据（.gdd）记录 etag/md5，恢复时校验远端文件未变更
 * - 完成后流式 MD5 校验，再改名落定
 */
export class DownloadTask {
  get partPath(): string {
    return this.task.localPath + '.part'
  }

  get metaPath(): string {
    return this.task.localPath + '.gdd'
  }

  constructor(private task: TransferTask) {}

  /** 崩溃恢复：以 .part 文件实际大小为断点 */
  async reconcileFromDisk(): Promise<void> {
    const t = this.task
    try {
      const stat = await fsp.stat(this.partPath)
      t.transferred = Math.min(stat.size, t.size)
      // 已收满但没改名（上次在最后一步崩溃）→ 直接落定
      if (t.size > 0 && stat.size === t.size) await this.finalize()
    } catch {
      t.transferred = 0
    }
  }

  async run(signal: AbortSignal, onProgress: (bytes: number) => void): Promise<void> {
    const t = this.task
    const isExport = !!t.exportMime
    // 元数据补全（断点校验 etag / 完整性 md5 / 精确大小）；失败按列表已知信息继续下载
    try {
      const meta = await driveClient.get(t.remoteId || '', 'id,headRevisionId,md5Checksum,size')
      if (meta.size) t.size = parseInt(meta.size, 10)
      t.etag = meta.headRevisionId
      t.remoteMd5 = meta.md5Checksum
    } catch {
      /* 拿不到元数据不阻塞下载 */
    }
    if (!isExport && t.transferred >= t.size && t.size > 0) {
      await this.finalize()
      return
    }
    let start = t.transferred
    // export 端点不支持 Range，只能整段重下；普通文件从 .part 断点继续
    try {
      const stat = await fsp.stat(this.partPath)
      if (isExport) start = 0
      else if (stat.size < start) start = stat.size
    } catch {
      start = 0
    }
    onProgress(start)

    const token = await authService.getAccessToken()
    const url = isExport
      ? `https://www.googleapis.com/drive/v3/files/${t.remoteId}/export?mimeType=${encodeURIComponent(t.exportMime!)}`
      : `https://www.googleapis.com/drive/v3/files/${t.remoteId}?alt=media&supportsAllDrives=true`
    const headers: Record<string, string> = { authorization: `Bearer ${token}` }
    if (start > 0) {
      headers.range = `bytes=${start}-`
      const etagMeta = await this.readMeta()
      if (etagMeta && t.etag) headers['if-range'] = t.etag // 远端文件变了就整段重下
    }

    const res = await netClient.request(url, { headers, timeoutMs: 60000, signal })
    if (res.status === 416) {
      // 断点已到文件末尾 → 落定；但 .part 大小和已知大小对不上说明远端文件被换过，丢弃断点防止拿坏文件当成品
      const partSize = (await fsp.stat(this.partPath).catch(() => null))?.size ?? -1
      if (partSize === t.size) {
        await this.finalize()
        return
      }
      logger.warn('断点大小与远端文件不一致，丢弃断点', t.fileName, `${partSize} ≠ ${t.size}`)
      await this.clearPart()
      throw new Error('远端文件已变化（大小不一致），断点已丢弃，请重新下载')
    }
    if (!res.ok && res.status !== 206 && res.status !== 200) {
      const text = await res.text()
      throw new Error(`下载失败（HTTP ${res.status}）：${text.slice(0, 300)}`)
    }

    if (t.etag && !t.md5) {
      const m = (res.headers.get('etag') || '').replace(/"/g, '')
      if (m && m !== t.etag) {
        logger.warn('远端文件已变更，重头下载', t.fileName)
        start = 0
        await this.clearPart()
      }
    }

    if (res.status === 200 && start > 0) {
      // 服务端没按 Range 返回 206（If-Range 未命中/被忽略）：这是完整内容，必须从头写，避免错位拼接
      logger.warn('服务端返回完整内容，改从头下载', t.fileName)
      start = 0
      await this.clearPart()
    }

    await fsp.mkdir(path.dirname(t.localPath), { recursive: true })
    const hash = crypto.createHash('md5')
    // 断点续传：先把 .part 已有的前 start 字节喂进 hash——只算新收的后半段，MD5 必然和远端对不上
    if (start > 0) {
      const prefix = fs.createReadStream(this.partPath, { start: 0, end: start - 1 })
      for await (const c of prefix) hash.update(c)
    }
    const ws = fs.createWriteStream(this.partPath, { flags: start > 0 ? 'r+' : 'w', start })
    let received = start
    let lastEmit = 0

    const body = res.body
    if (!body) throw new Error('响应无内容')
    const nodeStream = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0])
    nodeStream.on('data', (chunk: Buffer) => {
      received += chunk.length
      hash.update(chunk)
      const now = Date.now()
      if (now - lastEmit > 300) {
        lastEmit = now
        onProgress(received)
      }
    })
    await pipeline(nodeStream, ws)
    onProgress(received)

    // 普通文件有确定大小；export 转换出来的内容长度未知，以流正常结束为准
    if (!isExport && t.size > 0 && received !== t.size) {
      t.transferred = received
      throw new Error(`传输不完整：已收 ${received}/${t.size} 字节`)
    }
    t.transferred = received
    t.md5 = hash.digest('hex')
    // 与 Google 登记的 md5Checksum 比对（export 内容 Google 不提供 md5，跳过）
    if (t.remoteMd5 && t.md5 !== t.remoteMd5) {
      throw new Error('MD5 校验失败：下载内容与远端不一致')
    }
    await this.writeMeta()
    await this.finalize()
  }

  private async finalize(): Promise<void> {
    const t = this.task
    // .part 不在了：同路径的另一任务（云端同名重复副本）已先改名落定 → 目标就位即算完成，不覆盖
    if (!fs.existsSync(this.partPath)) {
      if (await this.settledByPeer()) return
      throw new Error('断点文件缺失（可能已被同路径的其他任务清理），请重新下载')
    }
    // md5 校验（重试场景可能已算过）
    if (!t.md5) {
      t.md5 = await hashFile(this.partPath)
      await this.writeMeta()
    }
    await fsp.mkdir(path.dirname(t.localPath), { recursive: true })
    // 覆盖同名旧文件
    await fsp.rm(t.localPath, { force: true })
    await fsp.rename(this.partPath, t.localPath)
    await this.clearMeta()
    logger.info('下载完成', t.localPath)
  }

  /** 同名文件已由另一任务完成落定：目标存在且大小吻合即视为完成（不再覆盖，避免互相删对方成品） */
  private async settledByPeer(): Promise<boolean> {
    const t = this.task
    const st = await fsp.stat(t.localPath).catch(() => null)
    if (st && st.isFile() && (!t.size || st.size === t.size)) {
      logger.warn('同名文件已由另一任务完成，本次按完成处理', t.localPath)
      await this.clearMeta().catch(() => undefined)
      return true
    }
    return false
  }

  private async readMeta(): Promise<string | null> {
    try {
      const raw = await fsp.readFile(this.metaPath, 'utf-8')
      return JSON.parse(raw).etag ?? null
    } catch {
      return null
    }
  }

  private async writeMeta(): Promise<void> {
    try {
      await fsp.writeFile(this.metaPath, JSON.stringify({ etag: this.task.etag, md5: this.task.md5 }), 'utf-8')
    } catch {
      /* ignore */
    }
  }

  private async clearMeta(): Promise<void> {
    await fsp.rm(this.metaPath, { force: true })
  }

  async clearPart(): Promise<void> {
    await fsp.rm(this.partPath, { force: true })
    this.task.transferred = 0
  }
}

function hashFile(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5')
    const rs = fs.createReadStream(p)
    rs.on('data', (c) => hash.update(c))
    rs.on('end', () => resolve(hash.digest('hex')))
    rs.on('error', reject)
  })
}
