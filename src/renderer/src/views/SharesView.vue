<template>
  <div class="page">
    <div class="toolbar">
      <el-button type="primary" :icon="Refresh" @click="load" :loading="loading">刷新</el-button>
      <el-text v-if="loading && progress" type="info">
        正在扫描云盘：已扫描 {{ progress.scanned }} 个文件，发现 {{ progress.shared }} 个分享…
      </el-text>
      <el-text v-else type="info">这里列出所有「我分享出去」的文件，点击管理权限</el-text>
    </div>

    <el-table :data="files" v-loading="loading"
      :empty-text="loading ? '正在扫描云盘…' : '还没有分享过任何文件'">
      <el-table-column label="文件" min-width="300">
        <template #default="{ row }">
          <div class="file-name">
            <span style="font-size: 18px">{{ fileIcon(row.mimeType, row.name) }}</span>
            <span>{{ row.name }}</span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="大小" width="110">
        <template #default="{ row }">{{ fmtSize(row.size) }}</template>
      </el-table-column>
      <el-table-column label="修改时间" width="170">
        <template #default="{ row }">{{ fmtTime(row.modifiedTime) }}</template>
      </el-table-column>
      <el-table-column width="220" align="right">
        <template #default="{ row }">
          <el-button size="small" text type="primary" @click="manage(row)">管理分享</el-button>
        </template>
      </el-table-column>
    </el-table>

    <ShareDialog v-model="shareVisible" :file="target" @changed="load" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Refresh } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import type { DriveFile } from '@core/types'
import { fmtSize, fmtTime, fileIcon } from '../utils/format'
import ShareDialog from '../components/ShareDialog.vue'

const files = ref<DriveFile[]>([])
const loading = ref(false)
const shareVisible = ref(false)
const target = ref<DriveFile | null>(null)
const progress = ref<{ scanned: number; shared: number } | null>(null)

async function load(): Promise<void> {
  loading.value = true
  progress.value = { scanned: 0, shared: 0 }
  try {
    files.value = await window.api.driveListShared()
  } catch (e) {
    ElMessage.error(`加载失败：${(e as Error).message}`)
  } finally {
    loading.value = false
    progress.value = null
  }
}

function manage(f: DriveFile): void {
  target.value = f
  shareVisible.value = true
}

onMounted(() => {
  window.api.onShareProgress((p) => (progress.value = p))
  void load()
})
</script>
