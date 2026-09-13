import { netClient } from '../net/NetClient'
import { authService } from '../auth/AuthService'
import { logger } from '../logger'
import type { DriveFile, StorageQuota, DrivePermission } from '../types'

const API = 'https://www.googleapis.com/drive/v3'
const FOLDER_MIME = 'application/vnd.google-apps.folder'

export interface ListResult {
  files: DriveFile[]
  nextPageToken?: string
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string
  ) {
    super(message)
  }
}

/** Drive API v3 封装：所有调用自动带 access token，401 时刷新重试一次 */
export class DriveClient {
  private async call<T>(url: string, init: RequestInit = {}, retried = false): Promise<T> {
    const token = await authService.getAccessToken()
    const res = await netClient.request(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` }
    })
    if (res.status === 401 && !retried) {
      // token 失效：强制刷新后重试一次
      await authService.getAccessToken()
      return this.call<T>(url, init, true)
    }
    const text = await res.text()
    if (!res.ok) {
      throw new ApiError(res.status, friendlyDriveError(res.status, text))
    }
    return (text ? JSON.parse(text) : ({} as T)) as T
  }

  async list(opts: {
    parentId?: string
    query?: string
    orderBy?: string
    pageSize?: number
    pageToken?: string
    trashed?: boolean
  }): Promise<ListResult> {
    const params = new URLSearchParams()
    const clauses: string[] = []
    if (opts.parentId) clauses.push(`'${escapeQuery(opts.parentId)}' in parents`)
    if (opts.trashed !== undefined) clauses.push(`trashed=${opts.trashed}`)
    if (opts.query) clauses.push(`name contains '${escapeQuery(opts.query)}'`)
    if (clauses.length) params.set('q', clauses.join(' and '))
    params.set('pageSize', String(opts.pageSize ?? 100))
    params.set(
      'fields',
      'nextPageToken,files(id,name,mimeType,size,modifiedTime,thumbnailLink,shared,trashed,starred,parents)'
    )
    params.set('orderBy', opts.orderBy ?? 'folder,modifiedTime desc')
    params.set('supportsAllDrives', 'true')
    if (opts.pageToken) params.set('pageToken', opts.pageToken)
    const r = await this.call<{ files?: DriveFile[]; nextPageToken?: string }>(`${API}/files?${params}`)
    return {
      files: (r.files || []).map((f) => ({ ...f, parentId: f.parents?.[0] })),
      nextPageToken: r.nextPageToken
    }
  }

  /** 列出「我分享出去」的文件：拉取自己名下的文件后按 shared 过滤（v3 无服务端 shared 过滤，只能扫描） */
  async listShared(onProgress?: (scanned: number, shared: number) => void): Promise<DriveFile[]> {
    const out: DriveFile[] = []
    let pageToken: string | undefined
    let scanned = 0
    do {
      const params = new URLSearchParams({
        q: `'me' in owners and trashed=false and mimeType != 'application/vnd.google-apps.folder'`,
        pageSize: '1000',
        fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,shared)',
        supportsAllDrives: 'true'
      })
      if (pageToken) params.set('pageToken', pageToken)
      const r = await this.call<{ files?: DriveFile[]; nextPageToken?: string }>(`${API}/files?${params}`)
      for (const f of r.files || []) {
        scanned++
        if (f.shared) out.push(f)
      }
      onProgress?.(scanned, out.length)
      pageToken = r.nextPageToken
    } while (pageToken)
    return out
  }

  async get(fileId: string, fields = '*'): Promise<DriveFile> {
    const params = new URLSearchParams({ fields, supportsAllDrives: 'true' })
    const r = await this.call<DriveFile>(`${API}/files/${fileId}?${params}`)
    return { ...r, parentId: r.parents?.[0] }
  }

  async about(): Promise<{ user?: { displayName?: string; emailAddress?: string }; storageQuota?: StorageQuota }> {
    return this.call(`${API}/about?fields=user,storageQuota`)
  }

  /** 读取小文件文本内容（预览/cat 共用）：超过 maxBytes 抛错，绝不整读大文件 */
  async readText(fileId: string, maxBytes = 2 * 1024 * 1024): Promise<string> {
    if (!/^[A-Za-z0-9_-]{10,64}$/.test(fileId)) throw new Error('非法文件 ID')
    const token = await authService.getAccessToken()
    const res = await netClient.request(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
      { headers: { authorization: `Bearer ${token}` }, timeoutMs: 30000 }
    )
    if (!res.ok) throw new Error(`读取失败（HTTP ${res.status}）`)
    const buf = await res.arrayBuffer()
    if (buf.byteLength > maxBytes) throw new Error(`文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB，请下载后查看`)
    return new TextDecoder('utf-8').decode(buf)
  }

  async createFolder(name: string, parentId: string): Promise<DriveFile> {
    return this.call(`${API}/files?supportsAllDrives=true&fields=id,name,mimeType`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] })
    })
  }

  /** 复制单个文件到目标文件夹（服务端复制，不占本地带宽） */
  async copy(fileId: string, parentId: string): Promise<DriveFile> {
    return this.call(`${API}/files/${fileId}/copy?supportsAllDrives=true&fields=id,name,mimeType`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parents: [parentId] })
    })
  }

  /** 递归复制文件夹（服务端逐文件 copy，返回进度） */
  async copyFolderRecursive(
    folderId: string,
    name: string,
    targetParentId: string,
    onProgress?: (done: number, total: number) => void
  ): Promise<DriveFile> {
    const folder = await this.call<DriveFile>(`${API}/files?supportsAllDrives=true&fields=id,name`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [targetParentId] })
    })
    // 先统计总数给进度
    let total = 0
    const count = async (id: string): Promise<void> => {
      const r = await this.call<{ files?: DriveFile[] }>(
        `${API}/files?q=${encodeURIComponent(`'${id}' in parents and trashed=false`)}&pageSize=200&fields=${encodeURIComponent('files(id,mimeType)')}&supportsAllDrives=true`
      )
      for (const f of r.files || []) {
        total++
        if (f.mimeType === FOLDER_MIME) await count(f.id)
      }
    }
    try {
      await count(folderId)
    } catch {
      total = 0
    }
    let done = 0
    const walk = async (srcId: string, destId: string): Promise<void> => {
      let pageToken: string | undefined
      do {
        const r = await this.call<{ files?: DriveFile[]; nextPageToken?: string }>(
          `${API}/files?q=${encodeURIComponent(`'${srcId}' in parents and trashed=false`)}&pageSize=100&fields=${encodeURIComponent('nextPageToken,files(id,name,mimeType,size)')}&supportsAllDrives=true`
        )
        for (const f of r.files || []) {
          if (f.mimeType === FOLDER_MIME) {
            await walk(f.id, destId)
          } else {
            await this.copy(f.id, destId)
          }
          done++
          onProgress?.(done, total)
        }
        pageToken = r.nextPageToken
      } while (pageToken)
    }
    await walk(folderId, folder.id)
    return folder
  }

  async rename(fileId: string, name: string): Promise<void> {
    await this.call(`${API}/files/${fileId}?supportsAllDrives=true`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name })
    })
  }

  async move(fileId: string, addParent: string, removeParent: string): Promise<void> {
    const params = new URLSearchParams({
      addParents: addParent,
      removeParents: removeParent,
      supportsAllDrives: 'true',
      fields: 'id'
    })
    await this.call(`${API}/files/${fileId}?${params}`, { method: 'PATCH' })
  }

  /**
   * 把 src 文件夹的全部子项（文件 + 子文件夹）整体移动到 dest 文件夹。
   * 子文件夹只换父（子树内容随文件夹一起走，无需递归），每项一次 PATCH，并发 4。
   * 404/410（远端已不存在，列表可能是 CF 缓存旧数据）视为跳过。返回 { moved, failed }。
   */
  async moveFolderContents(
    srcId: string,
    destId: string,
    onProgress?: (done: number, total: number, name: string) => void
  ): Promise<{ moved: number; failed: number }> {
    const items: DriveFile[] = []
    let pageToken: string | undefined
    do {
      const params = new URLSearchParams({
        q: `'${escapeQuery(srcId)}' in parents and trashed=false`,
        pageSize: '1000',
        fields: `nextPageToken,files(id,name)`,
        supportsAllDrives: 'true'
      })
      if (pageToken) params.set('pageToken', pageToken)
      const r = await this.call<{ files?: DriveFile[]; nextPageToken?: string }>(`${API}/files?${params}`)
      items.push(...(r.files || []))
      pageToken = r.nextPageToken
    } while (pageToken)

    let moved = 0
    let failed = 0
    let cursor = 0
    await Promise.all(
      Array.from({ length: Math.min(4, items.length) }, async () => {
        while (cursor < items.length) {
          const item = items[cursor++]
          try {
            await this.move(item.id, destId, srcId)
            moved++
          } catch (e) {
            if (e instanceof ApiError && (e.status === 404 || e.status === 410)) continue // 已不存在，无需搬
            failed++
            if (e instanceof Error) logger.warn('搬迁子项失败', item.name, e.message)
          }
          onProgress?.(moved + failed, items.length, item.name)
        }
      })
    )
    return { moved, failed }
  }

  async trash(fileId: string): Promise<void> {
    await this.call(`${API}/files/${fileId}?supportsAllDrives=true`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trashed: true })
    })
  }

  async untrash(fileId: string): Promise<void> {
    await this.call(`${API}/files/${fileId}?supportsAllDrives=true`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trashed: false })
    })
  }

  /** 彻底删除。404/410 视为成功：目标本来就不存在（列表常是 CF 缓存的旧数据），删无可删即目的已达成 */
  async deleteForever(fileId: string): Promise<void> {
    try {
      await this.call(`${API}/files/${fileId}?supportsAllDrives=true`, { method: 'DELETE' })
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 410)) return
      throw e
    }
  }

  /** 回收站全量列表：一次拉完所有分页（回收站可能有几千项，只拉一页会导致「永远删不完」的错觉） */
  async listTrash(): Promise<ListResult> {
    const out: DriveFile[] = []
    let pageToken: string | undefined
    do {
      const params = new URLSearchParams({
        q: 'trashed=true',
        pageSize: '1000',
        fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,trashed)',
        orderBy: 'modifiedTime desc',
        supportsAllDrives: 'true'
      })
      if (pageToken) params.set('pageToken', pageToken)
      const r = await this.call<{ files?: DriveFile[]; nextPageToken?: string }>(`${API}/files?${params}`)
      out.push(...(r.files || []))
      pageToken = r.nextPageToken
    } while (pageToken)
    return { files: out }
  }

  /**
   * 在指定文件夹及其全部子目录里按文件名搜索（资源管理器语义）。
   * Drive API 不支持「某文件夹及其后代」过滤，只能先 BFS 收集子文件夹 id 再逐个查询；结果上限 cap。
   */
  async searchInFolder(rootId: string, query: string, cap = 500): Promise<ListResult> {
    // 1. 收集 root 及全部子孙文件夹（上限 200 个，防止巨型目录树拖死搜索）
    const folderIds: string[] = [rootId]
    let frontier = [rootId]
    while (frontier.length && folderIds.length < 200) {
      const next: string[] = []
      for (const fid of frontier) {
        let pageToken: string | undefined
        do {
          const params = new URLSearchParams({
            q: `'${escapeQuery(fid)}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
            pageSize: '1000',
            fields: 'nextPageToken,files(id)',
            supportsAllDrives: 'true'
          })
          if (pageToken) params.set('pageToken', pageToken)
          const r = await this.call<{ files?: { id: string }[]; nextPageToken?: string }>(`${API}/files?${params}`)
          for (const f of r.files || []) {
            folderIds.push(f.id)
            next.push(f.id)
          }
          pageToken = r.nextPageToken
        } while (pageToken)
      }
      frontier = next
    }
    // 2. 逐个文件夹按名称匹配（文件夹本身也能被搜到）
    const out: DriveFile[] = []
    for (const fid of folderIds) {
      let pageToken: string | undefined
      do {
        const params = new URLSearchParams({
          q: `'${escapeQuery(fid)}' in parents and name contains '${escapeQuery(query)}' and trashed=false`,
          pageSize: '1000',
          fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,thumbnailLink,shared,trashed,starred,parents)',
          supportsAllDrives: 'true'
        })
        if (pageToken) params.set('pageToken', pageToken)
        const r = await this.call<{ files?: DriveFile[]; nextPageToken?: string }>(`${API}/files?${params}`)
        for (const f of r.files || []) out.push({ ...f, parentId: f.parents?.[0] })
        pageToken = out.length < cap ? r.nextPageToken : undefined
      } while (pageToken)
      if (out.length >= cap) break
    }
    return { files: out.slice(0, cap) }
  }

  /**
   * 清空回收站：v3 没有 emptyTrash 端点，只能逐个删。
   * 每轮先拉全量 trashed id 列表再并发删除；删完重新查询，直到查不到为止
   * （列表是最终一致+可能被 CF 缓存，单轮删不干净；某轮一个都删不动时停止防止死循环）。
   */
  async emptyTrash(onProgress?: (done: number, total: number) => void): Promise<{ deleted: number; failed: number }> {
    let deleted = 0
    for (let round = 0; ; round++) {
      const ids = await this.listTrashedIds()
      if (!ids.length) return { deleted, failed: 0 } // 全部删干净
      const total = deleted + ids.length
      let roundDeleted = 0
      let cursor = 0
      await Promise.all(
        Array.from({ length: Math.min(6, ids.length) }, async () => {
          while (cursor < ids.length) {
            const id = ids[cursor++]
            try {
              await this.deleteForever(id)
              deleted++
              roundDeleted++
            } catch {
              /* 限频/网络失败：下一轮列表里还会出现，自动重试 */
            }
            onProgress?.(deleted, total)
          }
        })
      )
      if (roundDeleted === 0) {
        // 这轮一个都删不动：剩下的就是删不掉的
        if (round === 0) throw new Error(`清空回收站失败：${ids.length} 个文件均无法删除`)
        return { deleted, failed: ids.length }
      }
    }
  }

  private async listTrashedIds(): Promise<string[]> {
    const out: string[] = []
    let pageToken: string | undefined
    do {
      const params = new URLSearchParams({
        q: 'trashed=true',
        pageSize: '1000',
        fields: 'nextPageToken,files(id)',
        supportsAllDrives: 'true'
      })
      if (pageToken) params.set('pageToken', pageToken)
      const r = await this.call<{ files?: { id: string }[]; nextPageToken?: string }>(`${API}/files?${params}`)
      for (const f of r.files || []) out.push(f.id)
      pageToken = r.nextPageToken
    } while (pageToken)
    return out
  }

  // ---- 分享 ----
  async listPermissions(fileId: string): Promise<DrivePermission[]> {
    const params = new URLSearchParams({ fields: 'permissions(id,type,role,emailAddress,displayName)', supportsAllDrives: 'true' })
    const r = await this.call<{ permissions?: DrivePermission[] }>(`${API}/files/${fileId}/permissions?${params}`)
    return r.permissions || []
  }

  async createAnyoneLink(fileId: string, role: 'reader' | 'writer'): Promise<string> {
    await this.call(`${API}/files/${fileId}/permissions?supportsAllDrives=true`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'anyone', role })
    })
    return this.webLink(fileId)
  }

  async deletePermission(fileId: string, permissionId: string): Promise<void> {
    await this.call(`${API}/files/${fileId}/permissions/${permissionId}?supportsAllDrives=true`, { method: 'DELETE' })
  }

  webLink(fileId: string): string {
    return `https://drive.google.com/file/d/${fileId}/view?usp=sharing`
  }
}

function escapeQuery(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

function friendlyDriveError(status: number, body: string): string {
  const detail = body.slice(0, 300)
  switch (status) {
    case 401:
      return '登录已过期（401），请重新登录'
    case 403: {
      if (body.includes('storageQuotaExceeded')) return 'Google 云盘空间已满（403）'
      if (body.includes('rateLimitExceeded') || body.includes('userRateLimitExceeded')) return '请求过于频繁（403），请稍后重试'
      if (body.includes('appNotAuthorizedToFile')) return '无权访问该文件（403）'
      return `访问被拒绝（403）：${detail}`
    }
    case 404:
      return '文件不存在或已被删除（404）'
    case 429:
      return '请求超过频率限制（429），正在稍后重试'
    default:
      if (status >= 500) return `Google 服务暂时不可用（${status}），将自动重试`
      return `请求失败（${status}）：${detail}`
  }
}

export const driveClient = new DriveClient()
export { FOLDER_MIME }
