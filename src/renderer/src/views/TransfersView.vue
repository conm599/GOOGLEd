<template>
  <div class="page">
    <div class="toolbar">
      <el-radio-group v-model="filter">
        <el-radio-button value="all">全部</el-radio-button>
        <el-radio-button value="running">进行中</el-radio-button>
        <el-radio-button value="paused">已暂停</el-radio-button>
        <el-radio-button value="error">失败</el-radio-button>
        <el-radio-button value="done">已完成</el-radio-button>
      </el-radio-group>
      <div style="flex: 1"></div>
      <el-button v-if="filter === 'error'" type="primary" @click="retryAllFailed" :disabled="!sumFailed">
        全部重试（{{ sumFailed }}）
      </el-button>
      <el-button @click="clearFinished" :disabled="!finishedCount">清除已完成</el-button>
      <el-button type="danger" plain @click="clearAll" :disabled="!store.tasks.length">清除所有任务</el-button>
    </div>

    <!-- 汇总进度：已传/剩余文件数、字节量、百分比、总速度 -->
    <div v-if="store.tasks.length" class="transfer-summary">
      <el-progress
        class="sum-bar"
        :percentage="sumPct"
        :stroke-width="10"
        :status="sumFailed ? 'exception' : sumPct >= 100 ? 'success' : undefined"
      />
      <div class="sum-stats">
        <el-text size="small">文件 <b>{{ sumDone }}</b>/{{ sumTotal }}</el-text>
        <el-text size="small" :type="sumLeft ? 'primary' : 'info'">剩余 {{ sumLeft }} 个</el-text>
        <el-text v-if="sumFailed" size="small" type="danger">失败 {{ sumFailed }}</el-text>
        <el-text size="small">{{ fmtSize(sumBytes) }} / {{ fmtSize(sumBytesTotal) }}（{{ sumPct }}%）</el-text>
        <el-text v-if="sumSpeed" size="small" type="primary">总速度 {{ fmtSpeed(sumSpeed) }}</el-text>
      </div>
    </div>

    <div ref="tableWrapRef" class="table-wrap" :style="{ height: store.tasks.length ? 'calc(100% - 108px)' : 'calc(100% - 60px)' }">
      <el-table :data="displayed" height="100%" empty-text="暂无传输任务">
      <el-table-column label="文件" min-width="280">
        <template #default="{ row }">
          <div class="file-name">
            <span style="font-size: 16px">{{ row.kind === 'upload' ? '⬆️' : '⬇️' }}</span>
            <span :title="row.kind === 'upload' ? row.localPath : row.fileName">{{ row.fileName }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="进度" min-width="240">
        <template #default="{ row }">
          <el-progress
            :percentage="pct(row)"
            :indeterminate="row.status === 'running' && row.size > 0 && !row.transferred"
            :status="row.status === 'error' ? 'exception' : row.status === 'done' ? 'success' : undefined"
            :stroke-width="8"
          />
          <el-text size="small" type="info">
            {{ fmtSize(row.transferred) }} / {{ fmtSize(row.size) }}
            <template v-if="row.status === 'running' && speedOf(row)"> · {{ fmtSpeed(speedOf(row)) }}</template>
            <template v-else-if="row.status === 'running' && row.size > 0 && !row.transferred"> · 正在传输…</template>
          </el-text>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="140">
        <template #default="{ row }">
          <el-tag size="small" :type="statusType(row.status)">{{ statusText(row) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column width="220" align="right">
        <template #default="{ row }">
          <el-button v-if="row.status === 'running'" size="small" text @click="pause(row.id)">暂停</el-button>
          <el-button v-if="['paused', 'error', 'canceled'].includes(row.status)" size="small" text type="primary"
            @click="resume(row.id)">继续</el-button>
          <el-button v-if="row.status === 'done' && row.kind === 'download'" size="small" text type="primary"
            @click="reveal(row)">打开位置</el-button>
          <el-button size="small" text type="danger" @click="remove(row.id)">移除</el-button>
        </template>
      </el-table-column>
    </el-table>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { TransferTask, TaskStatus } from '@core/types'
import { useAppStore } from '../stores/app'
import { fmtSize, fmtSpeed } from '../utils/format'
import { withToast } from '../utils/action'

const store = useAppStore()
const filter = ref('all')

/* ---------- 大量任务只渲染窗口：默认 200 条，滚近底部追加 200（几万任务也不卡） ---------- */
const renderLimit = ref(200)
const tableWrapRef = ref<HTMLElement>()
let tableScroller: HTMLElement | null = null
const displayed = computed(() => filtered.value.slice(0, renderLimit.value))
const onTableScroll = (): void => {
  const el = tableScroller
  if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 900) {
    renderLimit.value = Math.min(renderLimit.value + 200, filtered.value.length)
  }
}
watch(filter, () => {
  renderLimit.value = 200
})

// 速度显示保持：分块上传时速度只在块被确认的瞬间大于 0，保持最近一次非零值 4 秒，避免显示闪烁消失
const SPEED_HOLD_MS = 4000
const speedMemo = new Map<string, { v: number; at: number }>()
const tick = ref(0)
let tickTimer: number | undefined

function speedOf(t: TransferTask): number {
  void tick.value // 建立响应依赖：每秒刷新一次保持窗口的判断
  if (t.status === 'running' && t.speed) speedMemo.set(t.id, { v: t.speed, at: Date.now() })
  const m = speedMemo.get(t.id)
  if (!m) return 0
  if (Date.now() - m.at > SPEED_HOLD_MS) {
    speedMemo.delete(t.id)
    return 0
  }
  return m.v
}

onMounted(() => {
  void nextTick(() => {
    tableScroller = tableWrapRef.value?.querySelector<HTMLElement>('.el-scrollbar__wrap') ?? null
    tableScroller?.addEventListener('scroll', onTableScroll, { passive: true })
  })
  tickTimer = window.setInterval(() => {
    tick.value++
    const now = Date.now()
    for (const [id, m] of speedMemo) {
      if (now - m.at > SPEED_HOLD_MS * 2) speedMemo.delete(id)
    }
  }, 1000)
})
onUnmounted(() => {
  clearInterval(tickTimer)
  tableScroller?.removeEventListener('scroll', onTableScroll)
})

const filtered = computed(() => {
  const all = store.tasks
  if (filter.value === 'all') return all
  return all.filter((t) => t.status === filter.value)
})

const finishedCount = computed(
  () => store.tasks.filter((t) => t.status === 'done' || t.status === 'canceled').length
)

/* ---------- 汇总进度 ---------- */
const sumTotal = computed(() => store.tasks.length)
const sumDone = computed(() => store.tasks.filter((t) => t.status === 'done').length)
const sumFailed = computed(() => store.tasks.filter((t) => t.status === 'error').length)
const sumLeft = computed(
  () => store.tasks.filter((t) => t.status === 'queued' || t.status === 'running' || t.status === 'paused').length
)
const sumBytes = computed(() =>
  store.tasks.reduce((n, t) => n + (t.status === 'done' ? t.size || t.transferred : t.transferred || 0), 0)
)
const sumBytesTotal = computed(() => store.tasks.reduce((n, t) => n + (t.size || 0), 0))
const sumPct = computed(() => {
  if (!sumBytesTotal.value) return store.tasks.some((t) => t.status === 'done') ? 100 : 0
  return Math.min(100, Math.floor((sumBytes.value / sumBytesTotal.value) * 100))
})
const sumSpeed = computed(() => store.tasks.reduce((n, t) => n + (t.status === 'running' ? t.speed || 0 : 0), 0))

function pct(t: TransferTask): number {
  if (t.status === 'done') return 100
  if (!t.size) return 0
  return Math.min(99, Math.round((t.transferred / t.size) * 100))
}

function statusType(s: TaskStatus): 'success' | 'warning' | 'danger' | 'info' | 'primary' {
  switch (s) {
    case 'done':
      return 'success'
    case 'running':
      return 'primary'
    case 'error':
      return 'danger'
    case 'paused':
      return 'warning'
    default:
      return 'info'
  }
}

function statusText(t: TransferTask): string {
  switch (t.status) {
    case 'queued':
      return '排队中'
    case 'running':
      return '传输中'
    case 'paused':
      return '已暂停（可续传）'
    case 'done':
      return '已完成'
    case 'error':
      return t.error || '失败'
    case 'canceled':
      return '已取消'
  }
}

function pause(id: string): void {
  void withToast(() => window.api.pauseTask(id), '暂停失败')
}
async function retryAllFailed(): Promise<void> {
  const errs = store.tasks.filter((t) => t.status === 'error')
  if (!errs.length) return
  await withToast(async () => {
    for (const t of errs) await window.api.resumeTask(t.id)
    ElMessage.success(`已重新排队 ${errs.length} 个失败任务`)
  }, '重试失败')
}
function resume(id: string): void {
  void withToast(() => window.api.resumeTask(id), '继续失败')
}
function remove(id: string): void {
  void withToast(() => window.api.removeTask(id), '移除失败')
}
function clearFinished(): void {
  void withToast(() => window.api.clearFinished(), '清除失败')
}
async function clearAll(): Promise<void> {
  if (!store.tasks.length) return
  try {
    await ElMessageBox.confirm(
      `将清除全部 ${store.tasks.length} 个任务（含上传中与排队中），进行中的任务会被立即中断，未完成的断点文件会被删除。确定继续？`,
      '清除所有任务',
      { type: 'warning', confirmButtonText: '全部清除', confirmButtonClass: 'el-button--danger' }
    )
  } catch {
    return // 用户取消
  }
  await withToast(() => window.api.clearAllTasks(), '清除失败')
}
function reveal(t: TransferTask): void {
  void window.api.showItemInFolder(t.localPath).then(() => undefined).catch((e: Error) => ElMessage.error(e.message))
}
</script>

<style scoped>
.transfer-summary {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 8px 12px;
  margin-bottom: 8px;
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  background: var(--el-bg-color);
}
.sum-bar {
  flex: 1;
  min-width: 160px;
}
.sum-stats {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-shrink: 0;
  flex-wrap: wrap;
}
.table-wrap {
  height: calc(100% - 60px);
}
</style>
