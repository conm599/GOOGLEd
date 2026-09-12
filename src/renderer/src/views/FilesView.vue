<template>
  <div class="page" @dragover.prevent="onPageDragOver" @drop.prevent="onDrop" @mousedown="onBandStart">
    <!-- 工具栏 -->
    <div class="toolbar">
      <template v-if="!inTrash">
        <el-button type="primary" :icon="Upload" @click="upload(false)">上传文件</el-button>
        <el-button type="primary" plain :icon="FolderOpened" @click="upload(true)">上传文件夹</el-button>
        <el-button :icon="FolderAdd" @click="newFolder">新建文件夹</el-button>
        <el-input
          v-model="searchText"
          clearable
          :prefix-icon="Search"
          placeholder="搜索本文件夹（含子目录），回车"
          style="width: 250px"
          @keyup.enter="doSearch"
          @clear="doSearch"
        />
      </template>
      <el-button v-else :icon="Back" @click="leaveTrash">返回文件</el-button>
      <el-button v-if="inTrash" type="danger" plain :icon="Delete" :loading="emptying" @click="emptyTrash">清空回收站</el-button>
      <div style="flex: 1"></div>

      <el-select v-model="orderBy" style="width: 150px" @change="load">
        <el-option label="最近修改" value="folder,modifiedTime desc" />
        <el-option label="名称" value="folder,name" />
        <el-option label="大小" value="folder,quotaBytesUsed desc" />
      </el-select>
      <el-button-group>
        <el-button :type="view === 'list' ? 'primary' : ''" :icon="Grid" title="列表" @click="view = 'list'" />
        <el-button :type="view === 'grid' ? 'primary' : ''" :icon="Menu" title="缩略图" @click="view = 'grid'" />
      </el-button-group>
    </div>
    <!-- 面包屑 -->
    <el-breadcrumb v-if="!inTrash && !searching" style="margin-bottom: 10px; font-size: 13px">
      <el-breadcrumb-item>
        <el-link :underline="false" @click="goTo(-1)">☁️ 我的云盘</el-link>
      </el-breadcrumb-item>
      <el-breadcrumb-item v-for="(c, i) in crumbs" :key="c.id">
        <el-link :underline="false" @click="goTo(i)">{{ c.name }}</el-link>
      </el-breadcrumb-item>
    </el-breadcrumb>
    <el-alert v-if="searching && !inTrash" type="info" :closable="false" style="margin-bottom: 10px"
      :title="`「${searchText}」的搜索结果（当前文件夹及全部子目录，最多 500 条）`" />
    <el-alert v-if="inTrash && emptying" type="warning" :closable="false" style="margin-bottom: 10px"
      :title="emptyProgress || '正在清空回收站…'" />

    <!-- 列表视图 -->
    <div v-if="view === 'list'" ref="listWrapRef" class="table-wrap">
      <el-table ref="tableRef" :data="files" v-loading="loading" height="100%"
        :row-class-name="rowClassName"
        @row-contextmenu="onRowContext" @row-dblclick="onActivate" @row-click="onRowClick"
        :empty-text="loading ? '加载中…' : '此文件夹为空'">
        <el-table-column label="名称" min-width="300">
          <template #default="{ row }">
            <div class="file-name" :draggable="ctrlDown && !inTrash" data-drag-handle
              @dragstart="onDragStart($event, row)"
              @dragover="onRowDragOver($event, row)" @dragleave="onRowDragLeave(row)" @drop="onRowDrop($event, row)"
              :class="{ 'drop-target': dragOverId === row.id && isFolder(row.mimeType) }">
              <span style="font-size: 18px">{{ fileIcon(row.mimeType, row.name) }}</span>
              <span :title="row.name">{{ row.name }}</span>
              <el-tag v-if="row.shared" size="small" type="success">已分享</el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="大小" width="110">
          <template #default="{ row }">{{ isFolder(row.mimeType) ? '—' : fmtSize(row.size) }}</template>
        </el-table-column>
        <el-table-column label="修改时间" width="170">
          <template #default="{ row }">{{ fmtTime(row.modifiedTime) }}</template>
        </el-table-column>
        <el-table-column width="260" align="right">
          <template #default="{ row }">
            <el-button v-if="!inTrash && !isFolder(row.mimeType)" size="small" text type="primary"
              @click.stop="download(row)">下载</el-button>
            <el-button v-if="!inTrash" size="small" text @click.stop="share(row)">分享</el-button>
            <el-button v-if="!inTrash" size="small" text type="danger" @click.stop="trash(row)">删除</el-button>
            <template v-else>
              <el-button size="small" text type="primary" @click.stop="restore(row)">还原</el-button>
              <el-button size="small" text type="danger" @click.stop="deleteForever(row)">彻底删除</el-button>
            </template>
          </template>
        </el-table-column>
      </el-table>
    </div>

    <!-- 网格视图 -->
    <div v-else ref="gridWrapRef" class="thumb-grid" v-loading="loading">
      <div v-for="f in files" :key="f.id" class="thumb-card" :data-file-id="isImage(f) && f.thumbnailLink ? f.id : undefined"
        :class="{ 'card-selected': selected.has(f.id), 'cut-out': isCut(f.id), 'drop-target': dragOverId === f.id && isFolder(f.mimeType) }"
        :draggable="!inTrash"
        @dblclick="onActivate(f)" @contextmenu.prevent="showMenu($event.clientX, $event.clientY, f)"
        @click="onGridClick(f, $event)"
        @dragstart="onDragStart($event, f)"
        @dragover="onRowDragOver($event, f)" @dragleave="onRowDragLeave(f)" @drop="onRowDrop($event, f)">
        <template v-if="isImage(f) && f.thumbnailLink">
          <div class="thumb-box">
            <img v-if="thumbs[f.id]" class="thumb-img" :src="thumbs[f.id]" draggable="false" />
            <div v-else class="thumb-placeholder">🖼️</div>
          </div>
        </template>
        <div v-else class="thumb-box">
          <div class="thumb-placeholder" style="font-size: 40px">{{ fileIcon(f.mimeType, f.name) }}</div>
        </div>
        <div class="thumb-name" :title="f.name">{{ f.name }}</div>
      </div>
    </div>

    <!-- 框选矩形 -->
    <teleport to="body">
      <div v-if="band.visible" class="rubber-band" :style="{
        left: band.left + 'px',
        top: band.top + 'px',
        width: band.width + 'px',
        height: band.height + 'px',
        clipPath: band.clip
      }" />
    </teleport>

    <!-- 右键菜单 -->
    <teleport to="body">
      <div v-if="ctx.visible" class="ctx-menu" :style="{ left: ctx.x + 'px', top: ctx.y + 'px' }">
        <template v-if="!inTrash">
          <div v-if="!isFolder(ctx.file?.mimeType || '')" class="ctx-item" @click="download(ctx.file!)">下载（断点续传）</div>
          <div v-if="isFolder(ctx.file?.mimeType || '')" class="ctx-item" @click="onActivate(ctx.file!)">打开</div>
          <div class="ctx-item" @click="copySelFromCtx">复制</div>
          <div class="ctx-item" @click="cutSelFromCtx">剪切</div>
          <div class="ctx-item" @click="moveToPicker(ctx.file!)">移动到…</div>
          <div class="ctx-item" @click="copyToPicker(ctx.file!)">复制到…</div>
          <div v-if="clipboard && isFolder(ctx.file?.mimeType || '')" class="ctx-item" @click="pasteInto(ctx.file!)">粘贴到此处</div>
          <div class="ctx-item" @click="share(ctx.file!)">分享…</div>
          <div class="ctx-item" @click="rename(ctx.file!)">重命名</div>
          <div class="ctx-item" @click="copyLinkIfShared(ctx.file!)">复制文件 ID</div>
          <div class="ctx-item danger" @click="trash(ctx.file!)">移至回收站</div>
        </template>
        <template v-else>
          <div class="ctx-item" @click="restore(ctx.file!)">还原</div>
          <div class="ctx-item danger" @click="deleteForever(ctx.file!)">彻底删除</div>
        </template>
      </div>
      <!-- 空白处右键：粘贴 -->
      <div v-if="ctxBlank.visible" class="ctx-menu" :style="{ left: ctxBlank.x + 'px', top: ctxBlank.y + 'px' }">
        <div class="ctx-item" @click="newFolder">新建文件夹</div>
        <div v-if="clipboard && !inTrash" class="ctx-item" @click="paste">粘贴</div>
        <div class="ctx-item" @click="load">刷新</div>
      </div>
    </teleport>

    <ShareDialog v-model="shareVisible" :file="shareTarget" @changed="load" />
    <PreviewDialog v-model="previewVisible" :file="previewTarget" @download="download(previewTarget!)" />
    <FolderPickerDialog ref="folderPickerRef" title="选择目标文件夹" @picked="onFolderPicked" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Upload, FolderAdd, FolderOpened, Delete, Back, Grid, Menu, Search } from '@element-plus/icons-vue'
import type { DriveFile } from '../../../shared/types'
import { useAppStore } from '../stores/app'
import { fmtSize, fmtTime, fileIcon, isFolder } from '../utils/format'
import { withToast, plain } from '../utils/action'
import ShareDialog from '../components/ShareDialog.vue'
import PreviewDialog from '../components/PreviewDialog.vue'
import FolderPickerDialog from '../components/FolderPickerDialog.vue'

const props = defineProps<{ initialTrash?: boolean }>()
const router = useRouter()
const store = useAppStore()

const files = ref<DriveFile[]>([])
const loading = ref(false)
const crumbs = ref<DriveFile[]>([])
const searchText = ref('')
const searching = ref(false)
const showTrash = ref(!!props.initialTrash)
const view = ref<'list' | 'grid'>('list')
const orderBy = ref('folder,modifiedTime desc')
const thumbs = ref<Record<string, string>>({})

const currentId = computed(() => (crumbs.value.length ? crumbs.value[crumbs.value.length - 1].id : 'root'))
const inTrash = computed(() => showTrash.value)

const shareVisible = ref(false)
const shareTarget = ref<DriveFile | null>(null)

const previewVisible = ref(false)
const previewTarget = ref<DriveFile | null>(null)

function onActivate(f: DriveFile): void {
  if (isFolder(f.mimeType)) {
    crumbs.value = [...crumbs.value, f]
    searching.value = false
    searchText.value = ''
    void load()
    return
  }
  // 文件：双击直接预览（视频/音频/文本/docx/pdf/图片），不支持的建议下载
  previewTarget.value = f
  previewVisible.value = true
}

const ctx = reactive({ visible: false, x: 0, y: 0, file: null as DriveFile | null })
const ctxBlank = reactive({ visible: false, x: 0, y: 0 })

/* ---------- 多选（Windows 逻辑：色阶高亮，无勾选框） ---------- */
const selected = ref<Set<string>>(new Set())
const ctrlDown = ref(false)
let anchorIndex = -1

const selectedRows = computed(() => files.value.filter((f) => selected.value.has(f.id)))

function clearSelection(): void {
  selected.value = new Set()
  anchorIndex = -1
}

// el-table row-click 的签名是 (row, column, event)，第二参必须跳过才是鼠标事件
function onRowClick(row: DriveFile, _col: unknown, ev: MouseEvent): void {
  const idx = files.value.findIndex((f) => f.id === row.id)
  if (ev.shiftKey && anchorIndex >= 0) {
    const [a, b] = [Math.min(anchorIndex, idx), Math.max(anchorIndex, idx)]
    selected.value = new Set(files.value.slice(a, b + 1).map((f) => f.id))
    return
  }
  if (ev.ctrlKey || ev.metaKey) {
    // Ctrl+点击：已选中则取消，未选中则选上（Windows 逻辑）
    const next = new Set(selected.value)
    if (next.has(row.id)) next.delete(row.id)
    else next.add(row.id)
    selected.value = next
    anchorIndex = idx
    return
  }
  selected.value = new Set([row.id])
  anchorIndex = idx
}

function onGridClick(f: DriveFile, ev: MouseEvent): void {
  onRowClick(f, null, ev)
}

function rowClassName({ row }: { row: DriveFile }): string {
  const cls: string[] = []
  if (selected.value.has(row.id)) cls.push('row-selected')
  if (clipboard.value?.mode === 'cut' && clipboard.value.items.some((i) => i.id === row.id)) cls.push('row-cut')
  if (dragOverId.value === row.id && isFolder(row.mimeType)) cls.push('row-drop')
  return cls.join(' ')
}

function isCut(id: string): boolean {
  return clipboard.value?.mode === 'cut' && clipboard.value.items.some((i) => i.id === id)
}

/* ---------- 剪贴板 ---------- */
const clipboard = ref<{ mode: 'copy' | 'cut'; items: DriveFile[] } | null>(null)

function grabSelection(f: DriveFile): DriveFile[] {
  // 如果操作对象在当前选中集里，作用于整个选中集（Windows 习惯）；否则只作用于它
  return selected.value.has(f.id) && selected.value.size > 1 ? [...selectedRows.value] : [f]
}

function copySel(f?: DriveFile): void {
  const items = grabSelection(f || selectedRows.value[0])
  if (!items.length) return
  clipboard.value = { mode: 'copy', items: items.map((i) => plain(i)) }
  ElMessage.success(`已复制 ${items.length} 项`)
}

function cutSel(f?: DriveFile): void {
  const items = grabSelection(f || selectedRows.value[0])
  if (!items.length) return
  clipboard.value = { mode: 'cut', items: items.map((i) => plain(i)) }
  ElMessage.success(`已剪切 ${items.length} 项`)
}

function copySelFromCtx(): void {
  if (ctx.file) copySel(ctx.file)
}

function cutSelFromCtx(): void {
  if (ctx.file) cutSel(ctx.file)
}

async function paste(): Promise<void> {
  const cb = clipboard.value
  if (!cb || inTrash.value || !cb.items.length) return
  const targetId = currentId.value
  loading.value = true
  let ok = 0
  let fail = 0
  let skipped = 0
  try {
    for (const item of cb.items) {
      try {
        if (cb.mode === 'cut') {
          if (item.parentId === targetId) {
            skipped++ // 原地跳过（Windows：同目录剪切粘贴 = 无操作）
            continue
          }
          await window.api.move(item.id, targetId, item.parentId || 'root')
        } else if (isFolder(item.mimeType)) {
          await window.api.driveCopyFolder(item.id, item.name, targetId)
        } else {
          await window.api.driveCopy(item.id, targetId)
        }
        ok++
      } catch {
        fail++
      }
    }
    if (cb.mode === 'cut') clipboard.value = null
    if (fail) ElMessage.warning(`粘贴完成：成功 ${ok}，失败 ${fail}`)
    else if (ok) ElMessage.success(`粘贴完成：成功 ${ok}`)
    else ElMessage.info(cb.mode === 'cut' ? '文件已在当前目录，无需移动' : '没有可粘贴的内容')
    await load()
  } finally {
    loading.value = false
  }
}

async function pasteInto(folder: DriveFile): Promise<void> {
  const cb = clipboard.value
  if (!cb) return
  let ok = 0
  let fail = 0
  loading.value = true
  try {
    for (const item of cb.items) {
      try {
        if (cb.mode === 'cut') {
          if (item.id === folder.id) continue
          await window.api.move(item.id, folder.id, item.parentId || 'root')
        } else if (isFolder(item.mimeType)) {
          if (item.id === folder.id) continue
          await window.api.driveCopyFolder(item.id, item.name, folder.id)
        } else {
          await window.api.driveCopy(item.id, folder.id)
        }
        ok++
      } catch {
        fail++
      }
    }
    if (cb.mode === 'cut') clipboard.value = null
    ElMessage[fail ? 'warning' : 'success'](`粘贴完成：成功 ${ok}${fail ? `，失败 ${fail}` : ''}`)
    ctx.visible = false
    await load()
  } finally {
    loading.value = false
  }
}

/* ---------- 移动/复制到…（文件夹选择器） ---------- */
const folderPickerRef = ref<InstanceType<typeof FolderPickerDialog>>()
let pickerAction: 'move' | 'copy' | null = null
let pickerItems: DriveFile[] = []

function moveToPicker(f: DriveFile): void {
  pickerAction = 'move'
  pickerItems = grabSelection(f)
  ctx.visible = false
  folderPickerRef.value?.open()
}

function copyToPicker(f: DriveFile): void {
  pickerAction = 'copy'
  pickerItems = grabSelection(f)
  ctx.visible = false
  folderPickerRef.value?.open()
}

async function onFolderPicked(target: { id: string; name: string }): Promise<void> {
  if (!pickerAction || !pickerItems.length) return
  const items = pickerItems.filter((i) => i.parentId !== target.id)
  if (!items.length) return
  const action = pickerAction
  pickerAction = null
  loading.value = true
  let ok = 0
  let fail = 0
  try {
    for (const item of items) {
      try {
        if (action === 'move') await window.api.move(item.id, target.id, item.parentId || 'root')
        else if (isFolder(item.mimeType)) await window.api.driveCopyFolder(item.id, item.name, target.id)
        else await window.api.driveCopy(item.id, target.id)
        ok++
      } catch {
        fail++
      }
    }
    ElMessage[fail ? 'warning' : 'success'](`${action === 'move' ? '移动' : '复制'}完成：成功 ${ok}${fail ? `，失败 ${fail}` : ''} → ${target.name}`)
    await load()
  } finally {
    loading.value = false
  }
}

/* ---------- 拖拽移动（应用内） ---------- */
const dragOverId = ref<string | null>(null)
const GD_MIME = 'application/x-gd-items'

function onDragStart(ev: DragEvent, f: DriveFile): void {
  const items = selected.value.has(f.id) ? [...selectedRows.value] : [f]
  ev.dataTransfer?.setData(GD_MIME, JSON.stringify(items.map((i) => ({ id: i.id, parentId: i.parentId || 'root' }))))
  if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move'
}

function onRowDragOver(ev: DragEvent, f: DriveFile): void {
  if (!ev.dataTransfer || ![...ev.dataTransfer.types].includes(GD_MIME)) return
  if (!isFolder(f.mimeType)) return
  ev.preventDefault()
  ev.dataTransfer.dropEffect = 'move'
  dragOverId.value = f.id
}

function onRowDragLeave(f: DriveFile): void {
  if (dragOverId.value === f.id) dragOverId.value = null
}

async function onRowDrop(ev: DragEvent, folder: DriveFile): Promise<void> {
  dragOverId.value = null
  const raw = ev.dataTransfer?.getData(GD_MIME)
  if (!raw) return
  ev.preventDefault()
  ev.stopPropagation()
  let items: { id: string; parentId: string }[] = []
  try {
    items = JSON.parse(raw)
  } catch {
    return
  }
  const list = items.filter((i) => i.id !== folder.id && i.parentId !== folder.id)
  if (!list.length) return
  loading.value = true
  let ok = 0
  let fail = 0
  try {
    for (const i of list) {
      try {
        await window.api.move(i.id, folder.id, i.parentId)
        ok++
      } catch {
        fail++
      }
    }
    ElMessage[fail ? 'warning' : 'success'](`已移动 ${ok} 项到「${folder.name}」${fail ? `，失败 ${fail}` : ''}`)
    await load()
  } finally {
    loading.value = false
  }
}

/* ---------- 框选（橡皮筋，Windows 语义） ---------- */
const listWrapRef = ref<HTMLElement>()
const gridWrapRef = ref<HTMLElement>()
// 矩形按真实几何渲染（锚点随滚动移出视口），滚动容器外的部分用 clip-path 裁掉
const band = reactive({ visible: false, left: 0, top: 0, width: 0, height: 0, clip: 'none' })
let bandAnchorX = 0 // 按下点（内容坐标，滚动时锚在内容上不动）
let bandAnchorY = 0
let lastPointerX = 0 // 最近指针屏幕坐标（滚轮滚动时鼠标不动，用它维持另一侧边界）
let lastPointerY = 0
let bandBaseSelection: Set<string> = new Set()
// 拖拽期间扫过/滚过的行累积保留：滚出可视区后选择不丢失（Windows 行为）
let bandSwept = new Set<string>()

/** 真正的滚动容器：Element Plus 的 el-table 用 el-scrollbar 包裹，实际滚动的是 .el-scrollbar__wrap */
function getScroller(): HTMLElement | null {
  if (view.value === 'list') {
    return (
      listWrapRef.value?.querySelector<HTMLElement>('.el-table__body-wrapper .el-scrollbar__wrap') ??
      listWrapRef.value?.querySelector<HTMLElement>('.el-table__body-wrapper') ??
      null
    )
  }
  return gridWrapRef.value as HTMLElement | null
}

function rowSelector(): string {
  return view.value === 'list' ? 'tbody tr.el-table__row' : '.thumb-card'
}

function onBandStart(ev: MouseEvent): void {
  if (ev.button !== 0) return
  const target = ev.target as HTMLElement
  // Ctrl+按住文件名 = 拖拽移动（交给 HTML5 drag），此时不启动框选
  if (ctrlDown.value && target.closest('[data-drag-handle]')) return
  if (target.closest('button, a, input, label, .el-checkbox, .ctx-menu, .el-dialog')) return
  const scroller = getScroller()
  if (!scroller) return
  const sr = scroller.getBoundingClientRect()
  bandAnchorX = ev.clientX - sr.left + scroller.scrollLeft
  bandAnchorY = ev.clientY - sr.top + scroller.scrollTop
  lastPointerX = ev.clientX
  lastPointerY = ev.clientY
  band.visible = true
  band.left = ev.clientX
  band.top = ev.clientY
  band.width = 0
  band.height = 0
  bandBaseSelection = ev.ctrlKey || ev.metaKey ? new Set(selected.value) : new Set()
  bandSwept = new Set()
  // Windows 行为：普通按下立即清空原选择（Ctrl 按下则保留），点击空白即取消全选
  selected.value = new Set(bandBaseSelection)
  window.addEventListener('mousemove', onBandMove)
  window.addEventListener('mouseup', onBandEnd)
  scroller.addEventListener('scroll', onBandScroll) // 滚轮滚动时鼠标不动也要重算
  document.body.style.userSelect = 'none'
}

function onBandMove(ev: MouseEvent): void {
  const scroller = getScroller()
  if (!scroller) return
  lastPointerX = ev.clientX
  lastPointerY = ev.clientY
  const sr = scroller.getBoundingClientRect()
  // 边缘自动滚动：光标靠近滚动容器上下边缘 40px 内缓慢滚动（Windows 拖选体验）
  if (ev.clientY - sr.top < 40) scroller.scrollTop -= 12
  else if (sr.bottom - ev.clientY < 40) scroller.scrollTop += 12
  updateBand()
}

// 滚轮/自动滚动时鼠标不动也要重算：矩形裁剪到可视区 + 滚过的行补选中
function onBandScroll(): void {
  updateBand()
}

function onBandEnd(): void {
  band.visible = false
  window.removeEventListener('mousemove', onBandMove)
  window.removeEventListener('mouseup', onBandEnd)
  getScroller()?.removeEventListener('scroll', onBandScroll)
  document.body.style.userSelect = ''
  anchorIndex = -1
}

/** 依当前滚动量与指针位置更新：矩形=内容带与可视区的交集；扫过/滚过的行累积选中 */
function updateBand(): void {
  const scroller = getScroller()
  if (!scroller || !band.visible) return
  const sr = scroller.getBoundingClientRect()
  const curX = lastPointerX - sr.left + scroller.scrollLeft
  const curY = lastPointerY - sr.top + scroller.scrollTop
  const contentTop = Math.min(bandAnchorY, curY)
  const contentBottom = Math.max(bandAnchorY, curY)
  const contentLeft = Math.min(bandAnchorX, curX)
  const contentRight = Math.max(bandAnchorX, curX)

  // 渲染：真实几何矩形（顶/左锚在按下内容点，随滚动移出视口），超出滚动容器的部分裁掉
  band.left = sr.left + (contentLeft - scroller.scrollLeft)
  band.top = sr.top + (contentTop - scroller.scrollTop)
  band.width = Math.max(0, contentRight - contentLeft)
  band.height = Math.max(0, contentBottom - contentTop)
  const clipTop = Math.max(0, sr.top - band.top)
  const clipLeft = Math.max(0, sr.left - band.left)
  const clipRight = Math.max(0, band.left + band.width - sr.right)
  const clipBottom = Math.max(0, band.top + band.height - sr.bottom)
  band.clip = `inset(${clipTop}px ${clipRight}px ${clipBottom}px ${clipLeft}px)`

  // 选中：行内容坐标落在内容带内即累积选中（滚过的不丢）
  const wrap = view.value === 'list' ? listWrapRef.value : gridWrapRef.value
  const rows = wrap?.querySelectorAll<HTMLElement>(rowSelector()) ?? []
  rows.forEach((rowEl, idx) => {
    if (idx >= files.value.length) return
    const r = rowEl.getBoundingClientRect()
    const ry1 = r.top - sr.top + scroller.scrollTop
    const ry2 = ry1 + r.height
    const rx1 = r.left - sr.left + scroller.scrollLeft
    const rx2 = rx1 + r.width
    if (rx1 < contentRight && rx2 > contentLeft && ry1 < contentBottom && ry2 > contentTop) {
      bandSwept.add(files.value[idx].id)
    }
  })
  selected.value = new Set([...bandBaseSelection, ...bandSwept])
}

/* ---------- 快捷键 ---------- */
function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Control') ctrlDown.value = ev.type === 'keydown'
  const t = ev.target as HTMLElement
  if (t.closest('input, textarea, [contenteditable="true"], .el-dialog')) return
  if (!files.value.length) return
  const ctrl = ev.ctrlKey || ev.metaKey
  if (ctrl && ev.key.toLowerCase() === 'a') {
    ev.preventDefault()
    selected.value = new Set(files.value.map((f) => f.id))
    return
  }
  if (inTrash.value) return
  if (!ctrl || !['c', 'x', 'v'].includes(ev.key.toLowerCase())) return
  ev.preventDefault()
  if (ev.key.toLowerCase() === 'c') copySel(selectedRows.value[0])
  else if (ev.key.toLowerCase() === 'x') cutSel(selectedRows.value[0])
  else if (ev.key.toLowerCase() === 'v') void paste()
}

function onKeyup(ev: KeyboardEvent): void {
  if (ev.key === 'Control') ctrlDown.value = false
}

/* ---------- 批量回收站操作 ---------- */
/* ---------- 原有功能 ---------- */
const isImage = (f: DriveFile): boolean => /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name)

async function load(): Promise<void> {
  loading.value = true
  try {
    if (inTrash.value) {
      const r = await window.api.driveListTrash()
      files.value = r.files
      nextPageToken = undefined
    } else if (searching.value) {
      const r = await window.api.driveSearch(currentId.value, searchText.value)
      files.value = r.files
      nextPageToken = undefined
    } else {
      // 必须显式过滤回收站：files.list 不传 trashed 时会连已删除文件一起返回
      const r = await window.api.driveList({ parentId: currentId.value, orderBy: orderBy.value, pageSize: 100, trashed: false })
      files.value = r.files
      nextPageToken = r.nextPageToken
      loadThumbs()
    }
  } catch (e) {
    ElMessage.error(`加载失败：${(e as Error).message}`)
  } finally {
    clearSelection()
    loading.value = false
    armInfiniteScroll()
  }
}

/* ---------- 分组无限加载：每批 100 个，滚近底部自动追加下一页 ---------- */
let nextPageToken: string | undefined
let loadingMore = false

async function loadMore(): Promise<void> {
  if (loadingMore || loading.value || !nextPageToken || inTrash.value) return
  loadingMore = true
  try {
    const r = await window.api.driveList({
      parentId: currentId.value,
      query: searching.value ? searchText.value : undefined,
      orderBy: orderBy.value,
      pageToken: nextPageToken,
      pageSize: 100,
      trashed: false
    })
    nextPageToken = r.nextPageToken
    files.value = files.value.concat(r.files)
    loadThumbs()
  } catch {
    /* 静默失败：继续滚动会重试 */
  } finally {
    loadingMore = false
  }
}

let scrollEl: HTMLElement | null = null
const onScrollerScroll = (): void => {
  const el = scrollEl
  if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 600) void loadMore()
}

/** 把滚动监听挂到当前视图真正的滚动容器上（列表=el-table 内部，宫格=.thumb-grid） */
function armInfiniteScroll(): void {
  void nextTick(() => {
    scrollEl?.removeEventListener('scroll', onScrollerScroll)
    scrollEl = getScroller()
    scrollEl?.addEventListener('scroll', onScrollerScroll, { passive: true })
  })
}

/* ---------- 缩略图懒加载：IntersectionObserver 只加载滚进可视区的卡片，滚到哪加载到哪 ---------- */
let thumbObserver: IntersectionObserver | null = null

function loadThumbs(): void {
  thumbObserver ??= new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue
        const el = en.target as HTMLElement
        thumbObserver?.unobserve(el)
        const id = el.dataset.fileId
        if (!id || thumbs.value[id]) continue
        void window.api.thumbGet(id).then((d) => {
          if (d) thumbs.value[id] = d
        })
      }
    },
    { rootMargin: '400px' } // 提前 400px 预载，正常速度滚动时基本无感
  )
  void nextTick(() => {
    if (view.value !== 'grid') return
    const wrap = gridWrapRef.value
    if (!wrap) return
    for (const el of wrap.querySelectorAll<HTMLElement>('.thumb-card[data-file-id]')) {
      thumbObserver?.observe(el)
    }
  })
}

function doSearch(): void {
  searching.value = !!searchText.value
  void load()
}

/** 从回收站视图返回文件列表（回收站现在是侧边栏的独立入口） */
function leaveTrash(): void {
  showTrash.value = false
  void router.push('/')
}

function goTo(index: number): void {
  crumbs.value = crumbs.value.slice(0, index + 1)
  searching.value = false
  searchText.value = ''
  void load()
}

async function upload(folder: boolean): Promise<void> {
  try {
    const n = folder ? await window.api.addUploadFolder(currentId.value) : await window.api.addUploads(currentId.value)
    if (n) ElMessage.success(`已加入 ${n} 个传输任务`)
  } catch (e) {
    ElMessage.error(`上传失败：${(e as Error).message}`)
  }
}

async function onDrop(ev: DragEvent): Promise<void> {
  if (inTrash.value) return
  // 应用内拖拽由文件夹目标处理，这里只处理外部文件上传
  if ([...(ev.dataTransfer?.types || [])].includes(GD_MIME)) return
  const paths: string[] = []
  for (const item of ev.dataTransfer?.files || []) {
    const p = window.api.pathForFile(item)
    if (p) paths.push(p)
  }
  if (!paths.length) return
  try {
    const n = await window.api.addUploadPaths(paths, currentId.value)
    ElMessage.success(`已加入 ${n} 个传输任务`)
  } catch (e) {
    ElMessage.error(`上传失败：${(e as Error).message}`)
  }
}

function onPageDragOver(ev: DragEvent): void {
  if ([...(ev.dataTransfer?.types || [])].includes(GD_MIME)) return // 内部拖拽只认文件夹目标
  ev.preventDefault()
}

async function newFolder(): Promise<void> {
  let name: string
  try {
    const r = await ElMessageBox.prompt('输入文件夹名称', '新建文件夹', { inputValue: '新建文件夹' })
    name = r.value?.trim() || ''
  } catch {
    return // 用户取消
  }
  if (!name) return
  await withToast(async () => {
    await window.api.createFolder(name, currentId.value)
    await load()
  }, '新建文件夹失败')
}

async function rename(f: DriveFile): Promise<void> {
  let value: string
  try {
    const r = await ElMessageBox.prompt('新名称', '重命名', { inputValue: f.name })
    value = r.value?.trim() || ''
  } catch {
    return // 用户取消
  }
  if (!value || value === f.name) return
  await withToast(async () => {
    await window.api.rename(f.id, value)
    await load()
  }, '重命名失败')
}

async function download(f: DriveFile): Promise<void> {
  // 浅拷贝 + preload 端 plain() 纯化：行对象是深层 reactive Proxy，直接传 IPC 会克隆失败
  await withToast(async () => {
    await window.api.addDownload(plain(f))
    ElMessage.success(`「${f.name}」已加入下载队列`)
  }, '下载失败')
}

function share(f: DriveFile): void {
  shareTarget.value = f
  shareVisible.value = true
}

function copyLinkIfShared(f: DriveFile): void {
  void withToast(async () => {
    await navigator.clipboard.writeText(f.id)
    ElMessage.success(`已复制文件 ID：${f.id}`)
  }, '复制失败')
}

async function trash(f: DriveFile): Promise<void> {
  const items = grabSelection(f)
  const label = items.length > 1 ? `将选中的 ${items.length} 项移至回收站？` : `将「${f.name}」移至回收站？`
  try {
    await ElMessageBox.confirm(label, '删除', { type: 'warning' })
  } catch {
    return // 用户取消
  }
  await withToast(async () => {
    for (const it of items) await window.api.trash(it.id)
    clearSelection()
    await load()
  }, '删除失败')
}

async function restore(f: DriveFile): Promise<void> {
  const items = grabSelection(f)
  await withToast(async () => {
    for (const it of items) await window.api.untrash(it.id)
    clearSelection()
    await load()
  }, '还原失败')
}

async function deleteForever(f: DriveFile): Promise<void> {
  const items = grabSelection(f)
  const label = items.length > 1 ? `彻底删除选中的 ${items.length} 项？此操作不可恢复！` : `彻底删除「${f.name}」？此操作不可恢复！`
  try {
    await ElMessageBox.confirm(label, '危险操作', {
      type: 'error',
      confirmButtonText: '彻底删除'
    })
  } catch {
    return // 用户取消
  }
  await withToast(async () => {
    for (const it of items) await window.api.deleteForever(it.id)
    clearSelection()
    await load()
  }, '彻底删除失败')
}

/* ---------- 清空回收站（主进程逐个永久删除，回收站可能有几千项） ---------- */
const emptying = ref(false)
const emptyProgress = ref('')
let offTrashProgress: (() => void) | undefined

async function emptyTrash(): Promise<void> {
  const n = files.value.length
  try {
    await ElMessageBox.confirm(
      n
        ? `将永久删除回收站中的全部 ${n} 项，此操作不可恢复！确定继续？`
        : '将永久删除回收站中的全部内容，此操作不可恢复！确定继续？',
      '清空回收站',
      { type: 'error', confirmButtonText: '永久删除', confirmButtonClass: 'el-button--danger' }
    )
  } catch {
    return // 用户取消
  }
  emptying.value = true
  emptyProgress.value = ''
  try {
    const r = await window.api.emptyTrash()
    if (r.failed) ElMessage.warning(`已彻底删除 ${r.deleted} 项，${r.failed} 项暂时无法删除（稍后可重试）`)
    else ElMessage.success(`回收站已清空（共 ${r.deleted} 项）`)
  } catch (e) {
    ElMessage.error(`清空失败：${(e as Error).message}`)
  } finally {
    emptying.value = false
    clearSelection()
    await load()
  }
}

function onRowContext(row: DriveFile, _col: unknown, ev: MouseEvent): void {
  ev.preventDefault()
  if (!selected.value.has(row.id)) selected.value = new Set([row.id])
  showMenu(ev.clientX, ev.clientY, row)
}

function showMenu(x: number, y: number, f: DriveFile): void {
  ctx.x = x
  ctx.y = y
  ctx.file = f
  ctx.visible = true
  ctxBlank.visible = false
  window.addEventListener('click', closeCtx, { once: true })
  clampMenu(ctx)
}

/** 菜单渲染后测量实际尺寸，靠边就往回收，保证完整显示在窗口内 */
function clampMenu(menu: { x: number; y: number }): void {
  void nextTick(() => {
    const el = document.querySelector<HTMLElement>('.ctx-menu')
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (menu.x + rect.width > window.innerWidth - 6) menu.x = Math.max(6, window.innerWidth - rect.width - 6)
    if (menu.y + rect.height > window.innerHeight - 6) menu.y = Math.max(6, window.innerHeight - rect.height - 6)
  })
}

function closeCtx(): void {
  ctx.visible = false
}

/* 空白处右键：粘贴/新建 */
function onBlankContext(ev: MouseEvent): void {
  if ((ev.target as HTMLElement).closest('tr, .thumb-card, button, input')) return
  ev.preventDefault()
  ctxBlank.x = ev.clientX
  ctxBlank.y = ev.clientY
  ctxBlank.visible = true
  ctx.visible = false
  window.addEventListener('click', () => (ctxBlank.visible = false), { once: true })
  clampMenu(ctxBlank)
}

watch(showTrash, () => {
  clearSelection()
  void load()
})
watch(currentId, () => {
  clearSelection()
  void load()
})
// 切到宫格视图时（重新）挂观察器，让可见卡片的缩略图开始加载
watch(view, (v) => {
  if (v === 'grid') loadThumbs()
  armInfiniteScroll()
})

onMounted(() => {
  void load()
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('keyup', onKeyup)
  document.addEventListener('contextmenu', onBlankContext)
  offTrashProgress = window.api.onTrashProgress((p) => {
    emptyProgress.value = `正在清空回收站：${p.done} / ${p.total}`
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('keyup', onKeyup)
  document.removeEventListener('contextmenu', onBlankContext)
  offTrashProgress?.()
  thumbObserver?.disconnect()
  thumbObserver = null
  scrollEl?.removeEventListener('scroll', onScrollerScroll)
})
</script>

<style scoped>
.table-wrap {
  height: calc(100% - 130px);
  position: relative;
}
:deep(.row-selected td) {
  background: rgba(64, 158, 255, 0.28) !important;
}
:deep(.row-cut td .file-name) {
  opacity: 0.45;
}
:deep(.row-drop td) {
  background: var(--el-color-success-light-9) !important;
}
:deep(.row-drop td .file-name) {
  outline: 2px dashed var(--el-color-success);
  border-radius: 4px;
}
.file-name {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.file-name[draggable='true'] {
  cursor: grab;
}
.file-name.drop-target {
  outline: 2px dashed var(--el-color-success);
  border-radius: 4px;
  background: var(--el-color-success-light-9);
}
.rubber-band {
  position: fixed;
  border: 1px solid var(--el-color-primary);
  background: rgba(64, 158, 255, 0.12);
  z-index: 9999;
  pointer-events: none;
}
.ctx-menu {
  position: fixed;
  z-index: 9999;
  background: var(--el-bg-color-overlay);
  border: 1px solid var(--el-border-color-light);
  border-radius: 6px;
  box-shadow: var(--el-box-shadow-light);
  padding: 4px 0;
  min-width: 160px;
}
.ctx-item {
  padding: 7px 16px;
  cursor: pointer;
  font-size: 13px;
}
.ctx-item:hover {
  background: var(--el-fill-color-light);
}
.ctx-item.danger {
  color: var(--el-color-danger);
}
.thumb-grid {
  height: calc(100% - 130px);
  overflow: auto;
  position: relative;
  /* 行高贴合内容：内容不满一屏时行不再被拉伸填满容器（否则出现超长空白卡片/伪尾翼） */
  align-content: start;
}
/* 缩略图区固定高度 + overflow hidden：无论图片本身多大/什么状态，卡片高度都不可能被撑爆 */
.thumb-box {
  position: relative;
  height: 100px;
  border-radius: 4px;
  overflow: hidden;
  background: var(--el-fill-color-light);
}
.thumb-img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.thumb-placeholder {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.thumb-card {
  border: 2px solid transparent;
  /* 视口外的卡片跳过渲染/布局/绘制：几千个文件也只渲染看得见的部分（浏览器原生窗口化） */
  content-visibility: auto;
  contain-intrinsic-size: auto 160px;
}
.thumb-card.card-selected {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
}
.thumb-card.cut-out {
  opacity: 0.45;
}
.thumb-card.drop-target {
  border-color: var(--el-color-success);
  background: var(--el-color-success-light-9);
}
</style>
