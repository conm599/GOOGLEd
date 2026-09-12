<template>
  <el-dialog
    v-model="visible"
    :title="info ? `发现新版本 v${info.version}` : ''"
    width="560px"
    :close-on-click-modal="false"
    :show-close="!downloading"
    @closed="reset"
  >
    <div v-if="info && !downloading" class="update-notes">{{ info.notes || '（本次更新没有填写说明）' }}</div>
    <div v-if="downloading" class="update-progress">
      <el-progress :percentage="percent" :indeterminate="!total" />
      <el-text size="small" type="info">
        正在下载更新包（{{ fmtSize(received) }}{{ total ? ` / ${fmtSize(total)}` : '' }}），完成后将自动启动安装程序并关闭应用…
      </el-text>
    </div>
    <template #footer>
      <template v-if="!downloading">
        <el-button @click="ignore">忽略这次更新</el-button>
        <el-button @click="visible = false">取消</el-button>
        <el-button type="primary" @click="start">开始更新</el-button>
      </template>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ElMessage } from 'element-plus'
import type { UpdateInfo } from '../../../shared/types'
import { fmtSize } from '../utils/format'

const visible = ref(false)
const info = ref<UpdateInfo | null>(null)
const downloading = ref(false)
const received = ref(0)
const total = ref(0)
const percent = computed(() => (total.value ? Math.min(100, Math.round((received.value / total.value) * 100)) : 0))

let offProgress: (() => void) | undefined

function show(i: UpdateInfo): void {
  info.value = i
  downloading.value = false
  visible.value = true
}

function ignore(): void {
  if (info.value) void window.api.ignoreUpdate(info.value.version)
  visible.value = false
}

async function start(): Promise<void> {
  if (!info.value) return
  downloading.value = true
  received.value = 0
  total.value = 0
  try {
    await window.api.startUpdate(info.value)
    // 主进程下载完成后会自动拉起安装器并退出应用；走到这里说明已移交
    visible.value = false
  } catch (e) {
    ElMessage.error(`更新失败：${(e as Error).message}`)
    downloading.value = false
  }
}

function reset(): void {
  if (!downloading.value) info.value = null
}

onMounted(() => {
  offProgress = window.api.onUpdateProgress((p) => {
    received.value = p.received
    total.value = p.total
  })
})
onBeforeUnmount(() => offProgress?.())

defineExpose({ show })
</script>

<style scoped>
.update-notes {
  max-height: 300px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.7;
  padding: 10px 12px;
  background: var(--el-fill-color-light);
  border-radius: 6px;
}
.update-progress {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
</style>
