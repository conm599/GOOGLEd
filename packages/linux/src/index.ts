import * as fsp from 'node:fs/promises'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {
  loadSettings,
  saveSettings,
  authService,
  driveClient,
  netClient,
  transferEngine,
  backupManager,
  updateService,
  diskCache,
  workerTemplate,
  logger
} from '@core/index'
import { TaskStore } from '@core/transfer/taskStore'
import type { Settings, TransferTask } from '@core/types'
import { initLinuxPlatform, setBroadcastListener, dataDir, currentVersion } from './platform-node'
import {
  acquireLock,
  confirm,
  die,
  exitSoon,
  fmtDate,
  fmtSize,
  homeExpand,
  isTTY,
  out,
  resolveEntry,
  resolveFolder,
  setEngineListImpl,
  waitForIdle,
  type BroadcastListenerLike
} from './util'

const FOLDER_MIME = 'application/vnd.google-apps.folder'

// ---------- 参数解析 ----------

interface Args {
  _: string[]
  [key: string]: string | boolean | string[] | undefined
}

const SHORTS: Record<string, string> = { t: 'to', d: 'to', n: 'limit', r: 'role', q: 'quiet' }
const VALUE_FLAGS = new Set(['to', 'dir', 'role', 'in', 'name', 'parent', 'quiet', 'limit'])

function parseArgs(argv: string[]): Args {
  const args: Args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      if (VALUE_FLAGS.has(key)) {
        args[key] = argv[++i] ?? ''
      } else {
        args[key] = true
      }
    } else if (a.startsWith('-') && a.length > 1) {
      const key = SHORTS[a.slice(1)] || a.slice(1)
      if (VALUE_FLAGS.has(key)) args[key] = argv[++i] ?? ''
      else args[key] = true
    } else {
      args._.push(a)
    }
  }
  return args
}

// ---------- 事件渲染（进度） ----------

const reportedStatus = new Map<string, string>()

function clearLine(): void {
  if (isTTY) process.stdout.write('\r\x1b[K')
}

function makeProgressListener(): BroadcastListenerLike {
  return (channel, payload) => {
    if (channel === 'transfer:changed' && Array.isArray(payload)) {
      const tasks = payload as TransferTask[]
      if (!isTTY) {
        for (const t of tasks) {
          const prev = reportedStatus.get(t.id)
          if (prev !== t.status && ['done', 'error', 'canceled'].includes(t.status)) {
            const icon = t.status === 'done' ? '✅' : t.status === 'canceled' ? '⏹' : '❌'
            console.log(`${icon} ${t.status === 'error' ? `【${t.error}】` : ''}${t.kind === 'upload' ? '上传' : '下载'} ${t.fileName}（${fmtSize(t.size)}）`)
          }
          reportedStatus.set(t.id, t.status)
        }
        return
      }
      const running = tasks.filter((t) => t.status === 'running')
      const parts = running.slice(0, 3).map((t) => {
        const pct = t.size > 0 ? ((t.transferred / t.size) * 100).toFixed(1) : '?'
        const spd = t.speed ? `${fmtSize(t.speed)}/s` : ''
        return `${t.kind === 'upload' ? '↑' : '↓'} ${t.fileName.slice(0, 24)} ${pct}% ${spd}`
      })
      const queued = tasks.filter((t) => t.status === 'queued').length
      const failed = tasks.filter((t) => t.status === 'error').length
      const line = `${parts.join(' | ')}${parts.length ? ' | ' : ''}排队 ${queued}，失败 ${failed}`
      process.stdout.write(`\r${line.slice(0, 120)}\x1b[K`)
      return
    }
    if (channel === 'backup:progress' && payload && typeof payload === 'object') {
      const p = payload as { id?: string; message?: string }
      if (p.message) console.log(`[备份] ${p.message}`)
      return
    }
    if (channel === 'update:progress' && payload && typeof payload === 'object') {
      const p = payload as { received: number; total: number }
      const pct = p.total ? ((p.received / p.total) * 100).toFixed(1) : '?'
      process.stdout.write(`\r下载更新包 ${fmtSize(p.received)}/${fmtSize(p.total)}（${pct}%）\x1b[K`)
      return
    }
    if (channel === 'copy:progress' && payload && typeof payload === 'object') {
      const p = payload as { done: number; total: number }
      process.stdout.write(`\r云端复制 ${p.done}/${p.total}\x1b[K`)
    }
  }
}

// ---------- 启动引导 ----------

let booted = false

async function boot(): Promise<void> {
  if (booted) return
  booted = true
  const s = loadSettings()
  await netClient.applySettings(s)
  transferEngine.start()
  setEngineListImpl(() => transferEngine.list())
}

function summaryOfThisRun(startedAt: number, tasks: TransferTask[]): { done: number; error: number; canceled: number } {
  const mine = tasks.filter((t) => t.updatedAt >= startedAt)
  return {
    done: mine.filter((t) => t.status === 'done').length,
    error: mine.filter((t) => t.status === 'error').length,
    canceled: mine.filter((t) => t.status === 'canceled').length
  }
}

// ---------- 命令实现 ----------

function printFileRow(f: import('@core/types').DriveFile, long: boolean): void {
  if (long) {
    const kind = f.mimeType === FOLDER_MIME ? '<目录>' : fmtSize(f.size)
    out(`${f.id.slice(0, 8)}  ${kind.padEnd(10)}  ${fmtDate(f.modifiedTime)}  ${f.name}${f.shared ? '  [已分享]' : ''}`)
  } else {
    out(`${f.mimeType === FOLDER_MIME ? 'd' : '-'}  ${f.name}${f.mimeType === FOLDER_MIME ? '/' : ''}`)
  }
}

async function cmdLs(args: Args): Promise<void> {
  await boot()
  const target = args._[0] || ''
  const e = await resolveEntry(target)
  if (!e.isFolder) {
    printFileRow(e.file as import('@core/types').DriveFile, true)
    return
  }
  const r = await driveClient.list({ parentId: e.id, pageSize: 1000, trashed: false })
  const long = !!args.l
  r.files.forEach((f) => printFileRow(f, long))
  if (long) out(`\n共 ${r.files.length} 项`)
}

async function cmdMkdir(args: Args): Promise<void> {
  await boot()
  if (!args._.length) die('用法：googled mkdir <远程路径...>')
  for (const target of args._) {
    // 逐级建目录：已存在的直接复用
    const segments = target.split('/').filter(Boolean)
    let parent = await resolveFolder('')
    for (const seg of segments) {
      const r = await driveClient.list({ parentId: parent.id, pageSize: 200, trashed: false })
      const hit = r.files.find((f) => f.name === seg && f.mimeType === FOLDER_MIME)
      if (hit) parent = { id: hit.id, name: hit.name, isFolder: true }
      else {
        const created = await driveClient.createFolder(seg, parent.id)
        out(`已创建 ${parent.name === '我的云端硬盘' ? '' : parent.name + '/'}${seg}（${created.id.slice(0, 8)}）`)
        parent = { id: created.id, name: seg, isFolder: true }
      }
    }
    out(`✅ ${target} 就绪（${parent.id === 'root' ? 'root' : parent.id.slice(0, 8)}）`)
  }
}

async function cmdUpload(args: Args): Promise<void> {
  if (!args._.length) die('用法：googled upload <本地路径...> [-t 远程文件夹]')
  await boot()
  acquireLock()
  const folder = await resolveFolder((args.to as string) || '')
  const abs = args._.map(homeExpand)
  for (const p of abs) await fsp.access(p).catch(() => die(`本地路径不存在：${p}`))
  const count = await transferEngine.addUploadsFromPaths(abs, folder.id)
  if (!count) {
    out('没有可上传的文件')
    process.exit(0)
  }
  out(`已入队 ${count} 项 → ${folder.name}（并发 ${loadSettings().concurrency}）`)
  if (args['no-wait']) {
    out('不等待完成：任务已落盘，可运行 googled sync 或启动 daemon 处理')
    exitSoon()
    return
  }
  setBroadcastListener(makeProgressListener())
  const startedAt = Date.now()
  const s = await waitForIdle()
  clearLine()
  const r = summaryOfThisRun(startedAt, transferEngine.list())
  out(`\n完成 ${r.done}，失败 ${r.error}${r.error ? '（googled transfer list 查看，重新运行本命令或 sync 可断点续传）' : ''}`)
  process.exit(r.error ? 1 : 0)
}

async function cmdDownload(args: Args): Promise<void> {
  if (!args._.length) die('用法：googled download <远程路径或 id:xxx...> [-d 本地目录]')
  await boot()
  acquireLock()
  const s = loadSettings()
  const dest = (args.to as string) || s.downloadDir || path.join(os.homedir(), 'Downloads', 'GOOGLEd')
  await fsp.mkdir(dest, { recursive: true })
  let count = 0
  for (const t of args._) {
    const e = await resolveEntry(t)
    // 文件夹：以其名为根目录落盘（dest/文件夹名/子目录/…），与云端结构一致
    if (e.isFolder) count += await transferEngine.addDownloadFolderContents(e.id, path.join(dest, e.name))
    else count += await transferEngine.addDownload(e.file as import('@core/types').DriveFile, dest)
  }
  if (!count) {
    out('没有可下载的文件')
    process.exit(0)
  }
  out(`已入队 ${count} 个文件 → ${dest}`)
  if (args['no-wait']) {
    out('不等待完成：任务已落盘，可运行 googled sync 或启动 daemon 处理')
    exitSoon()
    return
  }
  setBroadcastListener(makeProgressListener())
  const startedAt = Date.now()
  await waitForIdle()
  clearLine()
  const r = summaryOfThisRun(startedAt, transferEngine.list())
  out(`\n完成 ${r.done}，失败 ${r.error}${r.error ? '（重新运行本命令或 sync 可断点续传）' : ''}`)
  process.exit(r.error ? 1 : 0)
}

async function cmdCat(args: Args): Promise<void> {
  await boot()
  if (!args._[0]) die('用法：googled cat <远程文件>')
  const e = await resolveEntry(args._[0])
  if (e.isFolder) die('目标是文件夹，不能 cat')
  const text = await driveClient.readText(e.id)
  process.stdout.write(text)
}

async function cmdRm(args: Args): Promise<void> {
  if (!args._.length) die('用法：googled rm <远程路径...> [--hard]')
  await boot()
  for (const t of args._) {
    const e = await resolveEntry(t)
    if (args.hard) {
      await driveClient.deleteForever(e.id)
      out(`已彻底删除 ${e.name}（${e.id.slice(0, 8)}）`)
    } else {
      await driveClient.trash(e.id)
      out(`已移入回收站 ${e.name}（${e.id.slice(0, 8)}，--hard 可彻底删除）`)
    }
  }
}

async function cmdMv(args: Args): Promise<void> {
  await boot()
  if (!args._[0] || !args.to) die('用法：googled mv <远程路径> -t <目标文件夹>')
  const e = await resolveEntry(args._[0])
  const dest = await resolveFolder(args.to as string)
  const parentId = e.file?.parentId || (await driveClient.get(e.id, 'parents')).parents?.[0]
  if (!parentId) die('取不到源文件的父目录')
  await driveClient.move(e.id, dest.id, parentId)
  out(`✅ 已移动 ${e.name} → ${dest.name}`)
}

async function cmdRename(args: Args): Promise<void> {
  await boot()
  if (!args._[0] || !args._[1]) die('用法：googled rename <远程路径> <新名字>')
  const e = await resolveEntry(args._[0])
  await driveClient.rename(e.id, args._[1])
  out(`✅ ${e.name} → ${args._[1]}`)
}

async function cmdCp(args: Args): Promise<void> {
  await boot()
  if (!args._[0] || !args.to) die('用法：googled cp <远程路径> -t <目标文件夹>')
  const e = await resolveEntry(args._[0])
  const dest = await resolveFolder(args.to as string)
  if (e.isFolder) {
    setBroadcastListener(makeProgressListener())
    const folder = await driveClient.copyFolderRecursive(e.id, e.name, dest.id)
    clearLine()
    out(`✅ 已复制文件夹 ${e.name} → ${dest.name}（${folder.id.slice(0, 8)}）`)
  } else {
    const f = await driveClient.copy(e.id, dest.id)
    out(`✅ 已复制 ${e.name} → ${dest.name}（${f.id.slice(0, 8)}）`)
  }
}

async function cmdSearch(args: Args): Promise<void> {
  await boot()
  if (!args._[0]) die('用法：googled search <关键字> [--in 文件夹]')
  const root = await resolveFolder((args.in as string) || '')
  const r = await driveClient.searchInFolder(root.id, args._[0])
  out(`「${args._[0]}」在 ${root.name} 下共 ${r.files.length} 项：`)
  r.files.forEach((f) => printFileRow(f, true))
}

async function cmdTrash(argv: string[]): Promise<void> {
  await boot()
  const sub = argv[0] || 'list'
  const args = parseArgs(argv.slice(1))
  if (sub === 'list') {
    const r = await driveClient.listTrash()
    const files = args.limit ? r.files.slice(0, parseInt(args.limit as string, 10) || 20) : r.files
    files.forEach((f) => printFileRow(f, true))
    out(`\n回收站共 ${r.files.length} 项`)
  } else if (sub === 'restore') {
    if (!args._[0]) die('用法：googled trash restore <文件id 或 路径>')
    const e = await resolveEntry(args._[0])
    await driveClient.untrash(e.id)
    out(`✅ 已还原 ${e.name}`)
  } else if (sub === 'empty') {
    if (!confirm('确定清空回收站？此操作不可恢复', !!args.y)) {
      out('已取消')
      return
    }
    setBroadcastListener(makeProgressListener())
    const r = await driveClient.emptyTrash((done, total) => {
      if (!isTTY && done % 50 === 0) console.log(`已删 ${done}/${total}`)
    })
    clearLine()
    out(`✅ 清空完成：删除 ${r.deleted}${r.failed ? `，无法删除 ${r.failed}` : ''}`)
  } else {
    die('用法：googled trash [list|restore|empty]')
  }
}

async function cmdShare(args: Args): Promise<void> {
  await boot()
  if (!args._[0]) die('用法：googled share <远程路径> [--role writer] | --revoke <远程路径> | --perms <远程路径>')
  const target = (args.revoke as string) || (args.perms as string) || args._[0]
  const e = await resolveEntry(target)
  if (args.perms) {
    const perms = await driveClient.listPermissions(e.id)
    if (!perms.length) out('（无权限条目）')
    perms.forEach((p) => out(`${p.type}\t${p.role}\t${p.emailAddress || p.displayName || p.id}`))
    return
  }
  if (args.revoke) {
    const perms = await driveClient.listPermissions(e.id)
    const anyone = perms.find((p) => p.type === 'anyone')
    if (!anyone) {
      out('该文件没有 anyone 链接分享')
      return
    }
    await driveClient.deletePermission(e.id, anyone.id)
    out(`✅ 已取消分享：${e.name}`)
    return
  }
  const role = (args.role as string) === 'writer' ? 'writer' : 'reader'
  const link = await driveClient.createAnyoneLink(e.id, role)
  out(`✅ 链接（${role === 'writer' ? '可编辑' : '可查看'}）：${link}`)
}

async function cmdShares(): Promise<void> {
  await boot()
  let scanned = 0
  const files = await driveClient.listShared((s, shared) => {
    if (isTTY) process.stdout.write(`\r扫描 ${s} 个文件，已分享 ${shared}…\x1b[K`)
  })
  scanned = files.length
  clearLine()
  out(`我分享出去的文件共 ${scanned} 个：`)
  files.forEach((f) => printFileRow(f, true))
}

async function cmdTransfer(argv: string[]): Promise<void> {
  await boot()
  const sub = argv[0] || 'list'
  const args = parseArgs(argv.slice(1))
  const findTask = (input: string): TransferTask | undefined => {
    const list = transferEngine.list()
    return list.find((t) => t.id === input) || list.find((t) => t.id.startsWith(input))
  }
  if (sub === 'list') {
    const list = transferEngine.list()
    if (!list.length) {
      out('队列为空')
      return
    }
    for (const t of list) {
      const pct = t.size > 0 ? ((t.transferred / t.size) * 100).toFixed(1) : '-'
      out(
        `${t.id.slice(0, 8)}  ${t.kind === 'upload' ? '↑传' : '↓传'}  ${t.status.padEnd(8)}  ${pct.padStart(6)}%  ${fmtSize(t.transferred)}/${fmtSize(t.size).padEnd(9)}  ${t.fileName}${t.error ? `  【${t.error}】` : ''}`
      )
    }
  } else if (sub === 'pause' || sub === 'resume' || sub === 'cancel') {
    if (!args._[0]) die(`用法：googled transfer ${sub} <任务id（可只给前缀）>`)
    const t = findTask(args._[0])
    if (!t) die('任务不存在')
    transferEngine[sub](t.id)
    out(`✅ 已 ${sub} ${t.fileName}`)
    exitSoon()
  } else if (sub === 'remove') {
    const t = findTask(args._[0])
    if (!t) die('任务不存在')
    await transferEngine.remove(t.id)
    out('✅ 已移除任务（断点文件一并清理）')
    exitSoon()
  } else if (sub === 'clear-finished') {
    transferEngine.clearFinished()
    out('✅ 已清空已完成/已取消任务')
    exitSoon()
  } else if (sub === 'clear-all') {
    if (!confirm('清除所有任务？进行中的也会中断', !!args.y)) return
    await transferEngine.clearAll()
    out('✅ 已清除所有任务')
    exitSoon()
  } else {
    die('用法：googled transfer [list|pause|resume|cancel|remove|clear-finished|clear-all]')
  }
}

async function cmdSync(args: Args): Promise<void> {
  await boot()
  acquireLock()
  const paused = transferEngine.list().filter((t) => ['paused', 'queued'].includes(t.status))
  for (const t of paused) transferEngine.resume(t.id)
  if (!paused.length) {
    out('队列无待处理任务')
    process.exit(0)
  }
  out(`恢复 ${paused.length} 个任务…`)
  setBroadcastListener(makeProgressListener())
  const startedAt = Date.now()
  await waitForIdle()
  clearLine()
  const r = summaryOfThisRun(startedAt, transferEngine.list())
  out(`\n完成 ${r.done}，失败 ${r.error}`)
  process.exit(r.error ? 1 : 0)
}

async function cmdDaemon(): Promise<void> {
  keepAlive = true
  acquireLock()
  await boot()
  // 上次运行中/排队中的任务自动恢复（真正用户手动暂停的不动）
  const inflight = new TaskStore().load().filter((t) => ['running', 'queued'].includes(t.status)).map((t) => t.id)
  for (const id of inflight) transferEngine.resume(id)
  backupManager.start()
  setTimeout(() => void diskCache.maybeAutoClean(), 30_000)
  setInterval(() => void diskCache.maybeAutoClean(), 30 * 60_000)
  logger.info('googled daemon 启动', { pid: process.pid })
  console.log(`googled daemon 已启动（pid ${process.pid}），备份监控/定时备份/传输队列持续运行，Ctrl+C 退出`)
  console.log('推荐用 systemd 常驻：googled install-service && systemctl --user enable --now googled')
}

async function cmdBackup(argv: string[]): Promise<void> {
  await boot()
  const sub = argv[0] || 'list'
  const args = parseArgs(argv.slice(1))
  const findBackup = async (input: string) => {
    const list = backupManager.list()
    const hit = list.find((b) => b.id === input || b.id.startsWith(input)) || list.find((b) => b.remoteName === input)
    if (hit) return hit
    die(`备份任务不存在：${input}（googled backup list 查看）`)
  }
  if (sub === 'add') {
    if (!args._[0]) die('用法：googled backup add <本地文件夹> [--name 云端名] [--parent 远程文件夹] [--quiet 分钟数] [--no-watch]')
    acquireLock()
    const local = homeExpand(args._[0])
    const st = await fsp.stat(local).catch(() => die(`本地路径不存在：${local}`))
    if (!st.isDirectory()) die('备份对象必须是文件夹')
    const parentFolderId = args.parent ? (await resolveFolder(args.parent as string)).id : 'root'
    const b = await backupManager.add(local, args.name as string | undefined, parentFolderId)
    if (args.quiet) await backupManager.setQuietMinutes(b.id, parseInt(args.quiet as string, 10))
    if (args['no-watch']) await backupManager.setWatch(b.id, false)
    out(`✅ 备份任务已创建：${local} → ${b.remoteName}（${b.id.slice(0, 8)}），首次全量同步进行中`)
    if (!args['no-wait']) {
      setBroadcastListener(makeProgressListener())
      exitSoon()
      return
    }
    exitSoon()
  } else if (sub === 'list') {
    const list = backupManager.list()
    if (!list.length) {
      out('暂无备份任务（googled backup add <文件夹> 创建）')
      return
    }
    for (const b of list) {
      out(
        `${b.id.slice(0, 8)}  ${b.remoteName.padEnd(16)}  ${b.syncing ? '同步中' : '空闲'}  本地 ${b.localCount} 项${b.pendingCount ? `（${b.pendingCount} 等待稳定）` : ''}  监控${b.watch ? '开' : '关'}  上次 ${b.lastSyncAt ? fmtDate(new Date(b.lastSyncAt).toISOString()) : '从未'}${b.lastError ? `  【${b.lastError}】` : ''}`
      )
      out(`          源：${b.localPath}`)
    }
    exitSoon()
  } else if (sub === 'remove') {
    if (!args._[0]) die('用法：googled backup remove <任务id前缀或名称>')
    const b = await findBackup(args._[0])
    await backupManager.remove(b.id)
    out('✅ 已移除备份任务（云端文件不动）')
    exitSoon()
  } else if (sub === 'sync') {
    if (!args._[0]) die('用法：googled backup sync <任务id前缀或名称>')
    acquireLock()
    const b = await findBackup(args._[0])
    setBroadcastListener(makeProgressListener())
    const r = await backupManager.syncNow(b.id, true)
    out(`✅ 扫描 ${r.scanned} 项，入队 ${r.queued} 个变更文件`)
    exitSoon()
  } else if (sub === 'watch') {
    keepAlive = true
    acquireLock()
    // watch = daemon 的备份部分
    const inflight = new TaskStore().load().filter((t) => ['running', 'queued'].includes(t.status)).map((t) => t.id)
    for (const id of inflight) transferEngine.resume(id)
    backupManager.start()
    console.log('备份监控运行中（文件变更自动增量备份 + 定时任务），Ctrl+C 退出')
    setInterval(() => undefined, 1 << 30) // 保活
  } else {
    die('用法：googled backup [add|list|remove|sync|watch]')
  }
}

async function cmdCache(argv: string[]): Promise<void> {
  await boot()
  const sub = argv[0] || 'stats'
  if (sub === 'stats') {
    const st = await diskCache.stats()
    out(`下载目录：${st.downloadDir}（共 ${fmtSize(st.downloadDirBytes)}）`)
    out(`孤儿断点：${st.orphanParts.count} 个 / ${fmtSize(st.orphanParts.bytes)}`)
    out(`更新包缓存：${fmtSize(st.updateCacheBytes)}`)
  } else if (sub === 'clean') {
    const r = await diskCache.clearOrphanParts()
    out(`✅ 清理 ${r.count} 个文件，释放 ${fmtSize(r.freed)}`)
  } else {
    die('用法：googled cache [stats|clean]')
  }
  exitSoon()
}

async function cmdUpdate(argv: string[]): Promise<void> {
  await boot()
  const sub = argv[0] || 'check'
  const r = await updateService.manualCheck()
  if (r.status === 'error') die(r.error || '检查更新失败')
  if (r.status === 'latest') {
    out(`已是最新版本（v${currentVersion()}）`)
    return
  }
  const info = r.info!
  out(`发现新版本 v${info.version}（当前 v${currentVersion()}）`)
  out(`更新包：${info.assetName}`)
  out(`\n${info.notes.slice(0, 1200)}\n`)
  if (sub === 'install') {
    setBroadcastListener(makeProgressListener())
    await updateService.downloadAndInstall(info)
    return // applyUpdate 成功后会自行退出
  }
  out('运行 googled update install 执行更新')
}

async function cmdInstallService(): Promise<void> {
  const self = process.argv[1] ? fs.realpathSync(process.argv[1]) : die('取不到当前程序路径')
  const dir = path.join(os.homedir(), '.config', 'systemd', 'user')
  fs.mkdirSync(dir, { recursive: true })
  const unit = `# 由 googled 生成：systemctl --user daemon-reload 后生效
[Unit]
Description=GOOGLEd CLI daemon (backup & transfer)
After=network-online.target

[Service]
ExecStart=${process.execPath} ${self} daemon
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`
  const file = path.join(dir, 'googled.service')
  fs.writeFileSync(file, unit)
  out(`✅ 已写入 ${file}`)
  out('启用：systemctl --user daemon-reload && systemctl --user enable --now googled')
  out('查看：journalctl --user -u googled -f')
  out('无桌面服务器请执行一次：loginctl enable-linger $USER（否则退出 SSH 后 user service 会停）')
}

async function cmdLogin(): Promise<void> {
  await boot()
  const s = loadSettings()
  if (!s.clientId || !s.clientSecret) {
    die('请先配置 OAuth 凭据：googled config import-client <客户端JSON> 或 googled config set clientId/clientSecret')
  }
  setBroadcastListener(makeProgressListener())
  const user = await authService.login()
  out(`✅ 登录成功：${user.email || '(未取到邮箱)'}（${user.name || ''}）`)
  exitSoon()
}

async function cmdLogout(): Promise<void> {
  await boot()
  await authService.logout()
  out('✅ 已退出登录')
  exitSoon()
}

async function cmdStatus(): Promise<void> {
  await boot()
  const s = loadSettings()
  const auth = authService.status()
  const tasks = transferEngine.list()
  out(`googled CLI v${currentVersion()}`)
  out(`数据目录：${dataDir()}`)
  out(`网络模式：${s.netMode}${s.netMode === 'workers' ? `（${s.workerBase.split(/[,\s;，；]+/)[0]}）` : s.netMode === 'proxy' ? `（${s.proxyProtocol}://${s.proxyHost}:${s.proxyPort}）` : ''}`)
  out(`账号：${auth.loggedIn ? (auth.user?.email || '已登录') + (auth.invalid ? '【授权已失效，请 relogin】' : '') : auth.configured ? '未登录（googled login）' : '未配置 OAuth（googled config import-client）'}`)
  out(`队列：${tasks.filter((t) => t.status === 'running').length} 传输中 / ${tasks.filter((t) => t.status === 'queued').length} 排队 / ${tasks.filter((t) => t.status === 'paused').length} 暂停 / ${tasks.filter((t) => t.status === 'error').length} 失败`)
  out(`备份任务：${backupManager.list().length} 个`)
}

async function cmdWhoami(): Promise<void> {
  await boot()
  const auth = authService.status()
  if (!auth.loggedIn) die('未登录')
  if (auth.user?.email) out(auth.user.email)
  else {
    const about = await driveClient.about()
    out(about.user?.emailAddress || '(未知)')
  }
}

async function cmdQuota(): Promise<void> {
  await boot()
  const about = await driveClient.about()
  const q = about.storageQuota || {}
  const used = parseInt(q.usageInDrive || '0', 10)
  const limit = parseInt(q.limit || '0', 10)
  out(`账号：${about.user?.emailAddress || '(未知)'}`)
  out(`空间：${fmtSize(used)}${limit ? ` / ${fmtSize(limit)}（${((used / limit) * 100).toFixed(1)}%）` : ''}`)
  out(`回收站占用：${fmtSize(parseInt(q.usageInDriveTrash || '0', 10))}`)
}

// ---------- config ----------

function maskSecret(s: Settings): Record<string, unknown> {
  return {
    ...s,
    clientSecret: s.clientSecret ? `${s.clientSecret.slice(0, 4)}****` : '',
    workerBase: s.workerBase || '(未配置)'
  }
}

async function cmdConfig(argv: string[]): Promise<void> {
  const sub = argv[0] || 'show'
  const args = parseArgs(argv.slice(1))
  if (sub === 'show') {
    const s = loadSettings()
    for (const [k, v] of Object.entries(maskSecret(s))) {
      out(`${k.padEnd(20)}${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    }
  } else if (sub === 'set') {
    if (!args._[0]) die('用法：googled config set <key> <value>（googled config show 查看全部键）')
    const [key, ...rest] = args._
    let value: unknown = rest.join(' ')
    const s = loadSettings() as unknown as Record<string, unknown>
    if (!(key in s)) die(`未知配置项：${key}（googled config show 查看）`)
    if (typeof s[key] === 'number') value = Number(value)
    else if (typeof s[key] === 'boolean') value = value === 'true' || value === '1'
    else if (Array.isArray(s[key])) {
      try {
        value = JSON.parse(String(value))
      } catch {
        value = String(value).split(/[,\s]+/).filter(Boolean)
      }
    }
    s[key] = value
    const ns = s as unknown as Settings
    saveSettings(ns)
    await netClient.applySettings(ns)
    out(`✅ ${key} = ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
  } else if (sub === 'import-client') {
    const file = args._[0]
    if (!file) die('用法：googled config import-client <Google 控制台下载的客户端 JSON>')
    const raw = JSON.parse(await fsp.readFile(homeExpand(file), 'utf-8')) as {
      installed?: { client_id?: string; client_secret?: string; project_id?: string }
      web?: { client_id?: string; client_secret?: string; project_id?: string }
    }
    const section = raw.installed || raw.web
    if (!section?.client_id || !section?.client_secret) {
      die('这个 JSON 里没有 client_id/client_secret——请确认创建时应用类型选了「桌面应用」')
    }
    const s = { ...loadSettings(), clientId: section.client_id!, clientSecret: section.client_secret! }
    saveSettings(s)
    out(`✅ 导入成功（项目：${section.project_id ?? '未知'}），现在可以 googled login`)
  } else if (sub === 'test-worker') {
    const s = loadSettings()
    if (!s.workerBase) die('请先 googled config set workerBase https://你的.workers.dev')
    const start = Date.now()
    try {
      const res = await netClient.request('https://www.googleapis.com/drive/v3/about?fields=user', { timeoutMs: 15000 })
      const ms = Date.now() - start
      if (res.status === 401 || res.status === 403 || res.status === 200) out(`✅ 链路通畅（HTTP ${res.status}，${ms}ms）`)
      else out(`⚠ 异常响应 HTTP ${res.status}`)
    } catch (e) {
      die(`连接失败：${(e as Error).message.slice(0, 120)}`)
    }
  } else if (sub === 'worker-template') {
    out(workerTemplate)
  } else {
    die('用法：googled config [show|set|import-client|test-worker|worker-template]')
  }
  exitSoon()
}

// ---------- 帮助 ----------

const HELP = `googled — GOOGLEd 云盘命令行（Linux，复用 Windows 版传输引擎）

用法：googled <命令> [参数]

账号
  login / logout / status / whoami        登录、退出、状态、当前账号
  quota                                   查看空间用量
文件
  ls [远程路径] [-l]                       列目录（root 可省略；id:前缀 直接用文件id）
  mkdir <远程路径...>                      逐级创建云端文件夹
  upload <本地路径...> -t <远程文件夹>      上传（断点续传，默认等完；--no-wait 落盘后台跑）
  download <远程路径...> -d <本地目录>      下载（支持文件夹递归；断点续传）
  cat <远程文件>                           打印小文件（≤2MB）内容到 stdout
  rm <远程路径...> [--hard]                移入回收站（--hard 彻底删除）
  mv <远程路径> -t <目标文件夹>             移动
  cp <远程路径> -t <目标文件夹>             云端复制（服务端进行）
  rename <远程路径> <新名字>                重命名
  search <关键字> [--in 文件夹]             文件夹树内搜索
分享
  share <路径> [--role writer]             创建 anyone 链接（默认可查看）
  share --revoke <路径> / --perms <路径>   取消分享 / 查看权限
  shares                                   扫描「我分享出去」的文件
回收站
  trash list [-n 数量] / restore <id> / empty [--yes]
传输
  transfer list                            查看队列（含断点任务）
  transfer pause|resume|cancel <id前缀>    暂停/继续/取消
  transfer remove <id前缀>                 移除任务（清断点）
  transfer clear-finished / clear-all      清理队列
  sync                                     恢复队列全部任务并等待完成
备份
  backup add <本地文件夹> [--name] [--parent] [--quiet 分钟] [--no-watch]
  backup list / remove <id|名> / sync <id|名>
  backup watch                             前台运行备份监控 + 定时任务
  daemon                                   备份监控 + 传输队列 + 缓存清理（配 systemd 常驻）
  install-service                          生成 systemd user 单元
配置 / 其他
  config show / set <k> <v> / import-client <json> / test-worker / worker-template
  update check|install                     检查 / 安装更新（多通道+断点续传）
  cache stats|clean                        缓存统计 / 清理孤儿断点

环境变量
  GOOGLED_HOME            数据目录（默认 ~/.config/googled）
  GOOGLED_TOKEN_PASSPHRASE  token 加密口令（设置后凭据绑口令，密钥不落盘）
  HTTP(S)_PROXY/ALL_PROXY   system 模式读取的代理`

// ---------- 主入口 ----------

/** daemon/watch 类常驻命令置真：跳过 main 的自动退出 */
let keepAlive = false

async function main(): Promise<void> {
  initLinuxPlatform()
  // Ctrl+C / kill 前同步落盘传输任务（合并写最长 1.8s，直接退出会丢状态）
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      try {
        transferEngine.flushSync()
      } catch {
        /* ignore */
      }
      process.exit(130)
    })
  }
  const [cmd, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)
  if (!cmd || cmd === 'help' || args.h || args.help) {
    out(HELP)
    process.exit(cmd ? 0 : 0)
  }
  switch (cmd) {
    case 'ls':
      await cmdLs(args)
      break
    case 'mkdir':
      await cmdMkdir(args)
      break
    case 'upload':
      await cmdUpload(args)
      break
    case 'download':
      await cmdDownload(args)
      break
    case 'cat':
      await cmdCat(args)
      break
    case 'rm':
      await cmdRm(args)
      break
    case 'mv':
      await cmdMv(args)
      break
    case 'cp':
      await cmdCp(args)
      break
    case 'rename':
      await cmdRename(args)
      break
    case 'search':
      await cmdSearch(args)
      break
    case 'share':
      await cmdShare(args)
      break
    case 'shares':
      await cmdShares()
      break
    case 'trash':
      await cmdTrash(rest)
      break
    case 'transfer':
      await cmdTransfer(rest)
      break
    case 'sync':
      await cmdSync(args)
      break
    case 'daemon':
      await cmdDaemon()
      break
    case 'backup':
      await cmdBackup(rest)
      break
    case 'cache':
      await cmdCache(rest)
      break
    case 'update':
      await cmdUpdate(rest)
      break
    case 'install-service':
      await cmdInstallService()
      break
    case 'login':
      await cmdLogin()
      break
    case 'logout':
      await cmdLogout()
      break
    case 'status':
      await cmdStatus()
      break
    case 'whoami':
      await cmdWhoami()
      break
    case 'quota':
      await cmdQuota()
      break
    case 'config':
      await cmdConfig(rest)
      break
    case 'version':
      out(currentVersion())
      break
    default:
      die(`未知命令：${cmd}（googled help 查看用法）`)
  }
  // 引擎的测速定时器会挂住事件循环：一次性命令打完收工（给 taskStore 的 800ms 合并写留落盘时间）
  if (!keepAlive) exitSoon(0)
}

main().catch((e) => die((e as Error).message || String(e)))
