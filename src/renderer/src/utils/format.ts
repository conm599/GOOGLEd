export function fmtSize(bytes?: string | number | null): string {
  const n = typeof bytes === 'string' ? parseInt(bytes, 10) : bytes
  if (n === undefined || n === null || isNaN(n)) return '—'
  if (n === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function fmtSpeed(bps?: number): string {
  if (!bps || bps <= 0) return ''
  return fmtSize(bps) + '/s'
}

export function fmtTime(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  const pad = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function isFolder(mime: string): boolean {
  return mime === 'application/vnd.google-apps.folder'
}

/** Google Docs 系列在线文档（无 size，导出才可下载） */
export function isGoogleDoc(mime: string): boolean {
  return mime.startsWith('application/vnd.google-apps.') && mime !== 'application/vnd.google-apps.folder'
}

export function fileIcon(mime: string, name: string): string {
  if (isFolder(mime)) return '📁'
  if (isGoogleDoc(mime)) {
    if (mime.includes('document')) return '📄'
    if (mime.includes('spreadsheet')) return '📊'
    if (mime.includes('presentation')) return '📽️'
    if (mime.includes('drawing')) return '🎨'
    if (mime.includes('form')) return '📝'
    return '🗒️'
  }
  const ext = name.split('.').pop()?.toLowerCase() || ''
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return '🖼️'
  if (['mp4', 'mkv', 'mov', 'avi', 'webm'].includes(ext)) return '🎬'
  if (['mp3', 'flac', 'wav', 'ogg', 'm4a'].includes(ext)) return '🎵'
  if (['zip', 'rar', '7z', 'gz', 'tar', 'iso'].includes(ext)) return '🗜️'
  if (['exe', 'msi', 'apk'].includes(ext)) return '⚙️'
  if (['pdf'].includes(ext)) return '📕'
  if (['doc', 'docx'].includes(ext)) return '📄'
  if (['xls', 'xlsx', 'csv'].includes(ext)) return '📊'
  if (['ppt', 'pptx'].includes(ext)) return '📽️'
  return '📃'
}
