import * as fs from 'node:fs'
import * as fsp from 'node:fs/promises'
import { netClient, isTransientNetError } from '../net/NetClient'
import { authService } from '../auth/AuthService'
import { driveClient } from '../drive/DriveClient'
import { loadSettings } from '../settings'
import { logger } from '../logger'
import type { TransferTask } from '../../shared/types'

/**
 * Resumable Upload（Google 官方断点续传协议）：
 * 1. 发起会话 → 拿到 sessionUri（落盘，崩溃后可恢复）
 * 2. 按 chunkSize 分块 PUT，Content-Range: bytes start-end/total
 * 3. 308=继续下一块；200/201=完成；5xx=用 bytes *\/total 查询服务器实际进度后继续
 * 服务器进度是唯一事实来源：恢复时先查询，再从真实偏移继续。
 */
export class UploadTask {
  constructor(private task: TransferTask) {}

  async run(signal: AbortSignal, onProgress: (bytes: number) => void, onMeta: (patch: Partial<TransferTask>) => void): Promise<void> {
    const t = this.task
    const total = t.size
    if (t.updateFileId) {
      t.remoteId = t.updateFileId
      // 更新已有文件：很小的文件单请求 media PATCH（绕开 resumable update 在部分反代下的 404）；
      // 大一点的必须走分块续传——单请求大 body 过 CF 反代必撞 ~100s 上游超时（524）
      if (total <= 8 * 1024 * 1024) {
        await this.updateInPlace(signal, onProgress)
        return
      }
      // 大文件更新：旧版先移入回收站（可逆），新版传完并校验通过后再彻底删除；
      // 直接 deleteForever 的话传一半失败 = 新旧全丢。移回收站失败就中止任务，绝不动旧文件
      const oldId = t.updateFileId
      await driveClient.trash(oldId)
      t.replacedOldId = oldId
      t.updateFileId = undefined
      t.remoteId = undefined
    }
    if (!t.sessionUri) {
      const uri = await this.initiate()
      t.sessionUri = uri
      onMeta({ sessionUri: uri })
    }
    // 查询服务器真实进度（新任务返回 308 无 Range，即从 0 开始）。
    // 0 字节文件：这次查询本身就是 finalize 请求（bytes */0），Google 直接完成创建并返回 200+元数据
    let offset = await this.queryProgress(total, onMeta)
    onProgress(offset)
    if (offset >= total) return

    const chunkSize = Math.max(1, loadSettings().chunkSizeMB) * 1024 * 1024
    const fh = await fsp.open(t.localPath, 'r')
    // 动态分块：CF 免费版反代约 100 秒收不到上游响应就强制断开（524）。
    // 慢线路上大分块传不完就被掐，且会永远卡在同一段；这里失败/过慢时自动减半（下限 256KB，Google 要求 256KB 倍数）
    let putBytes = chunkSize
    let serverErrors = 0
    let unauthorized = 0
    let netFailures = 0
    try {
      while (offset < total) {
        if (signal.aborted) throw new DOMException('paused', 'AbortError')
        const len = Math.min(putBytes, total - offset)
        const end = offset + len - 1
        const buf = Buffer.alloc(len)
        await fh.read(buf, 0, len, offset)

        const token = await authService.getAccessToken()
        const putStart = Date.now()
        // 注意：不能手动设 content-length（Electron net 层会报 ERR_INVALID_ARGUMENT），长度由 body 自动计算
        let res: Response
        try {
          res = await netClient.request(t.sessionUri, {
            method: 'PUT',
            timeoutMs: 120000,
            signal,
            headers: {
              authorization: `Bearer ${token}`,
              'content-type': t.mimeType || 'application/octet-stream',
              'content-range': `bytes ${offset}-${end}/${total}`
            },
            body: buf
          })
        } catch (e) {
          const err = e as Error
          if (signal.aborted || err.name === 'AbortError' || !isTransientNetError(err) || ++netFailures >= 3) throw e
          await wait(1500 * netFailures)
          offset = await this.queryProgress(total, onMeta)
          onProgress(offset)
          continue
        }
        netFailures = 0
        const putMs = Date.now() - putStart
        logger.info(
          `上传分块 ${offset}-${end}（${(len / 1024 / 1024).toFixed(1)}MB）→ HTTP ${res.status}，耗时 ${(putMs / 1000).toFixed(1)}s`,
          t.fileName
        )
        const text = await res.text()

        if (res.status === 200 || res.status === 201) {
          onProgress(total)
          try {
            const meta = JSON.parse(text) as { id?: string }
            if (meta.id) onMeta({ remoteId: meta.id })
          } catch {
            /* 200 但无 JSON，忽略 */
          }
          return
        }
        if (res.status === 308) {
          serverErrors = 0
          unauthorized = 0
          const range = res.headers.get('range')
          const next = range ? parseRangeEnd(range) + 1 : offset
          offset = next
          onProgress(offset)
          // 这一块快贴到代理超时线了：下一块主动减半，避免反复整块超时
          if (putMs > 90_000 && len > 256 * 1024) {
            putBytes = halveChunk(len)
            logger.warn(`分块耗时 ${(putMs / 1000).toFixed(0)}s 接近代理超时，自动减小到 ${putBytes / 1024}KB`, t.fileName)
          }
          continue
        }
        if (res.status === 401) {
          // 必须 forceRefresh：getAccessToken 在 token 未过期时只复用旧 token，会导致 401 无限循环
          if (++unauthorized >= 3) throw new Error('上传失败（401）：授权被拒绝，请重新登录')
          await authService.forceRefresh()
          continue
        }
        if (res.status >= 500 || res.status === 429) {
          serverErrors++
          if (serverErrors >= 6) {
            throw new Error(`上传反复失败（HTTP ${res.status}，已自动重试 ${serverErrors} 次）：线路对该分块不稳定，可稍后点「继续」或换个 Workers 域名`)
          }
          if (len > 256 * 1024) {
            putBytes = halveChunk(len)
            logger.warn(`分块被代理掐断（HTTP ${res.status}），自动减小到 ${putBytes / 1024}KB 后重试`, t.fileName)
          }
          await wait(backoffMs(res.status))
          offset = await this.queryProgress(total, onMeta)
          onProgress(offset)
          continue
        }
        throw new Error(`上传失败（HTTP ${res.status}）：${text.slice(0, 300)}`)
      }
    } finally {
      await fh.close()
    }
    onProgress(total)
  }

  /** 更新已有文件：单请求 media PATCH 全量替换内容 */
  private async updateInPlace(signal: AbortSignal, onProgress: (bytes: number) => void): Promise<void> {
    const t = this.task
    const total = t.size
    const fh = await fsp.open(t.localPath, 'r')
    try {
      const buf = Buffer.alloc(total)
      await fh.read(buf, 0, total, 0)
      for (let attempt = 1; ; attempt++) {
        if (signal.aborted) throw new DOMException('paused', 'AbortError')
        const token = await authService.getAccessToken()
        let res: Response
        try {
          res = await netClient.request(
            `https://www.googleapis.com/upload/drive/v3/files/${t.updateFileId}?uploadType=media&supportsAllDrives=true`,
            {
              method: 'PATCH',
              timeoutMs: 120000,
              signal,
              headers: {
                authorization: `Bearer ${token}`,
                'content-type': t.mimeType || 'application/octet-stream'
              },
              body: buf
            }
          )
        } catch (e) {
          const err = e as Error
          if (signal.aborted || err.name === 'AbortError' || !isTransientNetError(err) || attempt >= 3) throw e
          await wait(1500 * attempt)
          continue
        }
        if (res.status === 401) {
          await authService.getAccessToken()
          if (attempt >= 3) throw new Error('更新失败（401）')
          continue
        }
        if (res.ok) {
          onProgress(total)
          return
        }
        const text = await res.text()
        if ((res.status >= 500 || res.status === 429) && attempt < 3) {
          await wait(2000 * attempt)
          continue
        }
        throw new Error(`更新失败（HTTP ${res.status}）：${text.slice(0, 200)}`)
      }
    } finally {
      await fh.close()
    }
  }

  private async initiate(): Promise<string> {
    const t = this.task
    const token = await authService.getAccessToken()
    const res = await netClient.request(
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true',
      {
        method: 'POST',
        timeoutMs: 60000,
        signal: new AbortController().signal,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-type': t.mimeType || 'application/octet-stream',
          'x-upload-content-length': String(t.size)
        },
        body: JSON.stringify({ name: t.fileName, mimeType: t.mimeType || 'application/octet-stream', parents: t.parentId ? [t.parentId] : undefined })
      }
    )
    if (res.status !== 200) {
      const text = await res.text()
      throw new Error(`创建上传会话失败（HTTP ${res.status}）：${text.slice(0, 300)}`)
    }
    const uri = res.headers.get('location')
    if (!uri) throw new Error('Google 未返回上传会话地址')
    return uri
  }

  /** PUT bytes *\/total 询问服务器已收到多少字节；若返回 200 说明已传完（响应含文件元数据，记录 remoteId） */
  private async queryProgress(total: number, onMeta?: (patch: Partial<TransferTask>) => void): Promise<number> {
    if (!this.task.sessionUri) return 0
    const token = await authService.getAccessToken()
    const res = await netClient.request(this.task.sessionUri, {
      method: 'PUT',
      timeoutMs: 60000,
      headers: {
        authorization: `Bearer ${token}`,
        'content-range': `bytes */${total}`
      }
    })
    if (res.status === 200 || res.status === 201) {
      // 服务器已收完（0 字节文件的 finalize，或之前某次 200 响应丢失的场景）
      const text = await res.text()
      try {
        const meta = JSON.parse(text) as { id?: string }
        if (meta.id) onMeta?.({ remoteId: meta.id })
      } catch {
        /* 无 JSON 响应，忽略 */
      }
      return total
    }
    if (res.status === 308) {
      const range = res.headers.get('range')
      return range ? parseRangeEnd(range) + 1 : 0
    }
    if (res.status === 404 || res.status === 410) {
      // 会话过期/不存在：重开会话
      logger.warn('上传会话已失效，重新发起', this.task.fileName)
      this.task.sessionUri = undefined
      const uri = await this.initiate()
      this.task.sessionUri = uri
      onMeta?.({ sessionUri: uri }) // 新会话立刻落盘，崩了不至于拿旧失效会话恢复
      return 0
    }
    const text = await res.text()
    throw new Error(`上传进度查询失败（HTTP ${res.status}）：${text.slice(0, 200)}`)
  }

  /** 上传完成后用本地文件大小与远端核对 */
  async verify(remoteSize: number): Promise<boolean> {
    try {
      const stat = await fsp.stat(this.task.localPath)
      return stat.size === remoteSize
    } catch {
      return false
    }
  }
}

function parseRangeEnd(range: string): number {
  // "bytes=0-1048575" → 1048575
  const m = range.match(/bytes=0-(\d+)/)
  return m ? parseInt(m[1], 10) : -1
}

/** 分块减半，向下取 256KB 倍数（Google 分块要求 256KB 倍数），下限 256KB */
function halveChunk(len: number): number {
  return Math.max(256 * 1024, Math.floor(len / 2 / (256 * 1024)) * (256 * 1024))
}

function backoffMs(status: number): number {
  if (status === 429) return 5000
  return 3000
}

function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export { wait as sleepMs }
export function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}
