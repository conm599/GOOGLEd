import { protocol } from 'electron'
import { logger } from '../logger'
import { streamCache } from './StreamCache'

const FILE_ID_RE = /^[A-Za-z0-9_-]{10,64}$/

/**
 * gd:// 流式媒体通道（真流式）：
 * gd://media/<fileId> → StreamCache 分块取流（每块独立请求+重试+预取）。
 * 本层只做标准 Range/206/416 语义——开放式 Range 声明完整剩余长度，
 * 数据按需产出：播放器缓冲够了会停读（背压），上游就不再拉取；
 * 继续播放恢复读取才继续拉，seek 到新位置即从新位置拉取。
 * 严禁对开放式 Range 做人为截断——Chromium 会把读完有界 206 当成流结束
 * （表现：播完缓冲后不再加载、seek 未缓冲处回弹 0）。
 * registerSchemesAsPrivileged 必须在 app ready 之前调用。
 */
export function registerStreamScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'gd',
      privileges: { standard: true, stream: true, supportFetchAPI: true, secure: true }
    }
  ])
}

export function registerStreamHandler(): void {
  protocol.handle('gd', async (request) => {
    try {
      const url = new URL(request.url)
      const fileId = decodeURIComponent(url.pathname).replace(/^\/+|\/+$/g, '')
      if (!FILE_ID_RE.test(fileId)) return new Response('bad file id', { status: 400 })

      const entry = streamCache.get(fileId)
      const { size, mime } = await entry.ensureMeta()
      if (size === 0) {
        return new Response('', { status: 200, headers: { 'content-type': mime, 'content-length': '0' } })
      }

      // 解析 Range：bytes=start-end / bytes=start- / bytes=-suffix；无 Range = 全量
      let start = 0
      let end = size - 1
      let partial = false
      const rangeHeader = request.headers.get('range')
      const m = rangeHeader ? /bytes=(\d*)-(\d*)/.exec(rangeHeader) : null
      if (m && (m[1] || m[2])) {
        if (m[1] === '') {
          const n = Math.min(Number(m[2]), size)
          start = size - n
        } else {
          start = Number(m[1])
          end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
        }
        if (start >= size || start > end) {
          return new Response(null, {
            status: 416,
            headers: { 'content-range': `bytes */${size}`, 'accept-ranges': 'bytes' }
          })
        }
        end = Math.min(end, size - 1)
        partial = true
      }

      const headers = new Headers({
        'content-type': mime,
        'accept-ranges': 'bytes',
        'access-control-allow-origin': '*',
        'content-length': String(end - start + 1)
      })
      if (partial) headers.set('content-range', `bytes ${start}-${end}/${size}`)

      const gen = entry.iterRange(start, end)
      let closed = false
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (closed) {
            try { controller.close() } catch { /* 已关闭 */ }
            return
          }
          try {
            const { value, done } = await gen.next()
            if (closed || done) {
              try { controller.close() } catch { /* 已关闭 */ }
              return
            }
            controller.enqueue(value)
          } catch (e) {
            if (closed) return // 消费方已掐断（seek/关窗口），属正常
            logger.warn(`gd:// 出流中断 ${fileId}`, (e as Error).message)
            try { controller.error(e instanceof Error ? e : new Error(String(e))) } catch { /* 已关闭 */ }
          }
        },
        cancel() {
          // 播放器 seek/关闭会掐断旧请求，停止继续产出
          closed = true
          void gen.return(undefined)
        }
      })
      return new Response(body, { status: partial ? 206 : 200, headers })
    } catch (e) {
      logger.warn('gd:// 流式请求失败', (e as Error).message)
      return new Response(`stream error: ${(e as Error).message.slice(0, 200)}`, { status: 502 })
    }
  })
  logger.info('gd:// 流式协议已注册（分块缓存模式）')
}
