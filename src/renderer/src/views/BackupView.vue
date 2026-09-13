<template>
  <div class="page">
    <div class="toolbar">
      <el-button type="primary" :icon="FolderAdd" @click="startAdd">新增备份</el-button>
      <el-button :icon="Timer" @click="openSched">定时备份</el-button>
      <el-text type="info">绑定本地文件夹，变更自动增量备份到你的云盘</el-text>
    </div>

    <el-empty v-if="!tasks.length && !loading" description="还没有备份任务，点击「新增备份」开始" />

    <div v-for="t in tasks" :key="t.id" class="backup-card">
      <div class="backup-head">
        <div class="backup-title">
          <span class="icon">{{ t.watch ? '🔄' : '📦' }}</span>
          <div>
            <div class="name">
              {{ t.remoteName }}
              <el-tag size="small" :type="t.syncing ? 'warning' : 'info'" style="margin-left: 8px">
                {{ t.syncing ? '备份中…' : t.watch ? '自动监控中' : '手动模式' }}
              </el-tag>
            </div>
            <div class="paths">{{ t.localPath }} → 云盘/{{ t.remoteName }}</div>
          </div>
        </div>
        <div class="backup-actions">
          <el-switch v-model="t.watch" active-text="自动" @change="setWatch(t)" />
          <el-tooltip content="自动备份时，文件持续无变化达到该时长才上传（录屏/边写边传的文件不会被反复上传）；点「立即备份」则不受此限制" placement="top">
            <span class="quiet-setting">
              <el-input-number
                v-model="t.quietMinutes"
                size="small"
                :min="1"
                :max="120"
                :disabled="!t.watch"
                controls-position="right"
                style="width: 92px"
                @change="setQuiet(t)"
              />
              <el-text size="small" type="info">分钟内稳定才传</el-text>
            </span>
          </el-tooltip>
          <el-button size="small" type="primary" :loading="t.syncing" @click="syncNow(t)">立即备份</el-button>
          <el-popconfirm title="移除该备份任务？（云端已备份的文件不受影响）" @confirm="removeTask(t)">
            <template #reference>
              <el-button size="small" text type="danger">移除</el-button>
            </template>
          </el-popconfirm>
        </div>
      </div>
      <div class="backup-meta">
        <el-text size="small" type="info">
          本地 {{ t.localCount }} 个文件
          <template v-if="t.lastSyncAt"> · 上次备份 {{ fmtTime(new Date(t.lastSyncAt).toISOString()) }}（{{ t.lastSyncCount }} 个变更）</template>
          <template v-else> · 尚未备份</template>
        </el-text>
        <el-text v-if="t.pendingCount" size="small" type="warning">⏳ {{ t.pendingCount }} 个文件仍在写入，等待稳定后自动上传</el-text>
        <el-text v-if="schedText(t)" size="small" type="info">⏰ 定时：{{ schedText(t) }}</el-text>
        <el-text v-if="t.lastError" size="small" type="danger">{{ t.lastError }}</el-text>
      </div>
      <div v-if="progressOf(t.id)" class="backup-progress">
        <el-text size="small">{{ progressOf(t.id) }}</el-text>
      </div>
    </div>

    <!-- 新增备份对话框 -->
    <el-dialog v-model="adding" title="新增备份" width="520px">
      <el-form label-width="90px">
        <el-form-item label="本地文件夹">
          <div style="display: flex; gap: 8px; width: 100%">
            <el-input :model-value="draft.localPath || '未选择'" readonly />
            <el-button @click="pickFolder">选择…</el-button>
          </div>
        </el-form-item>
        <el-form-item label="备份到哪里">
          <div style="width: 100%">
            <div style="display: flex; gap: 8px; align-items: center">
              <el-input :model-value="draft.parentName || '云盘根目录（自动新建文件夹）'" readonly />
              <el-button @click="folderPickerRef?.open()">浏览…</el-button>
            </div>
            <el-text size="small" type="info" style="margin-top: 4px; display: inline-block">
              {{ draft.parentId === 'root' ? '将在云盘根目录自动创建同名文件夹（点「浏览」可选任意子文件夹）' : `将备份到「${draft.parentName}」内` }}
            </el-text>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="adding = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="confirmAdd">创建并开始首次备份</el-button>
      </template>
    </el-dialog>

    <!-- 定时备份对话框 -->
    <el-dialog v-model="schedOpen" title="定时备份" width="640px">
      <el-alert type="info" :closable="false" style="margin-bottom: 12px">
        到点自动执行一次增量备份（等待稳定的规则同样生效）。适合未开启「自动监控」的任务；间隔模式在应用重启后重新计时。
      </el-alert>
      <el-empty v-if="!tasks.length" description="还没有备份任务" :image-size="60" />
      <div v-for="t in tasks" :key="t.id" class="sched-row">
        <div class="sched-name">
          {{ t.remoteName }}
          <el-text size="small" type="info">{{ t.watch ? '（自动监控已开启）' : '（手动模式）' }}</el-text>
        </div>
        <div class="sched-cfg">
          <el-select v-model="schedDrafts[t.id].mode" size="small" style="width: 120px" @change="saveSchedule(t)">
            <el-option label="不定时" value="off" />
            <el-option label="每 N 小时" value="interval" />
            <el-option label="每天定时" value="daily" />
          </el-select>
          <template v-if="schedDrafts[t.id].mode === 'interval'">
            <el-input-number
              v-model="schedDrafts[t.id].intervalHours"
              size="small"
              :min="1"
              :max="168"
              controls-position="right"
              style="width: 96px"
              @change="saveSchedule(t)"
            />
            <el-text size="small" type="info">小时一次</el-text>
          </template>
          <template v-else-if="schedDrafts[t.id].mode === 'daily'">
            <el-time-picker
              v-model="schedDrafts[t.id].time"
              size="small"
              value-format="HH:mm"
              format="HH:mm"
              style="width: 110px"
              @change="saveSchedule(t)"
            />
          </template>
        </div>
      </div>
    </el-dialog>

    <FolderPickerDialog ref="folderPickerRef" title="选择备份位置" @picked="onParentPicked" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue'
import { FolderAdd, Timer } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import type { BackupTaskStatus } from '@core/types'
import { fmtTime } from '../utils/format'
import { withToast } from '../utils/action'
import FolderPickerDialog from '../components/FolderPickerDialog.vue'

const tasks = ref<BackupTaskStatus[]>([])
const loading = ref(true)
const adding = ref(false)
const creating = ref(false)
const folderPickerRef = ref<InstanceType<typeof FolderPickerDialog>>()
const draft = reactive({ localPath: '', name: '', parentId: 'root', parentName: '云盘根目录' })
const progressMap = ref<Record<string, string>>({})

function onParentPicked(target: { id: string; name: string }): void {
  draft.parentId = target.id
  draft.parentName = target.name
}

function progressOf(id: string): string {
  return progressMap.value[id] || ''
}

async function load(): Promise<void> {
  try {
    tasks.value = await window.api.backupList()
  } finally {
    loading.value = false
  }
}

function startAdd(): void {
  draft.localPath = ''
  draft.name = ''
  draft.parentId = 'root'
  draft.parentName = '云盘根目录'
  adding.value = true
}

async function pickFolder(): Promise<void> {
  const picked = await window.api.pickBackupFolder()
  if (!picked) return
  draft.localPath = picked.localPath
  if (!draft.name) draft.name = picked.suggestedName
}

async function confirmAdd(): Promise<void> {
  if (!draft.localPath) {
    ElMessage.warning('请先选择本地文件夹')
    return
  }
  creating.value = true
  try {
    await window.api.backupAdd(draft.localPath, draft.name.trim() || undefined, draft.parentId)
    adding.value = false
    ElMessage.success('备份任务已创建，正在首次备份')
    await load()
  } catch (e) {
    ElMessage.error(`创建失败：${(e as Error).message}`)
  } finally {
    creating.value = false
  }
}

async function syncNow(t: BackupTaskStatus): Promise<void> {
  await withToast(async () => {
    // 手动触发：跳过稳定检测，直接上传全部变更
    const r = await window.api.backupSyncNow(t.id, true)
    if (r.queued === 0) ElMessage.info('没有需要备份的变更，已是最新')
    else ElMessage.success(`已入队 ${r.queued} 个文件`)
    await load()
  }, '备份失败')
}

async function setQuiet(t: BackupTaskStatus): Promise<void> {
  await withToast(() => window.api.backupSetQuietMinutes(t.id, t.quietMinutes ?? 5), '设置失败')
}

// ---- 定时备份 ----
const schedOpen = ref(false)
interface SchedDraft {
  mode: 'off' | 'interval' | 'daily'
  intervalHours: number
  time: string
}
const schedDrafts = ref<Record<string, SchedDraft>>({})

function openSched(): void {
  const d: Record<string, SchedDraft> = {}
  for (const t of tasks.value) {
    const s = t.schedule
    d[t.id] = { mode: s?.mode ?? 'off', intervalHours: s?.intervalHours ?? 24, time: s?.time ?? '09:00' }
  }
  schedDrafts.value = d
  schedOpen.value = true
}

async function saveSchedule(t: BackupTaskStatus): Promise<void> {
  const d = schedDrafts.value[t.id]
  if (!d) return
  const schedule =
    d.mode === 'interval'
      ? { mode: 'interval' as const, intervalHours: d.intervalHours }
      : d.mode === 'daily'
        ? { mode: 'daily' as const, time: d.time }
        : undefined
  await withToast(() => window.api.backupSetSchedule(t.id, schedule), '设置失败')
}

function schedText(t: BackupTaskStatus): string {
  const s = t.schedule
  if (!s) return ''
  return s.mode === 'interval' ? `每 ${s.intervalHours} 小时` : `每天 ${s.time}`
}

async function setWatch(t: BackupTaskStatus): Promise<void> {
  await withToast(() => window.api.backupSetWatch(t.id, t.watch), '设置失败')
}

async function removeTask(t: BackupTaskStatus): Promise<void> {
  await withToast(async () => {
    await window.api.backupRemove(t.id)
    await load()
  }, '移除失败')
}

onMounted(() => {
  void load()
  window.api.onBackupChanged((t) => (tasks.value = t))
  window.api.onBackupProgress((p) => {
    progressMap.value = { ...progressMap.value, [p.id]: p.message }
    if (p.phase === 'done' || p.phase === 'error') {
      setTimeout(() => {
        const next = { ...progressMap.value }
        delete next[p.id]
        progressMap.value = next
      }, 6000)
    }
  })
})
</script>

<style scoped>
.backup-card {
  border: 1px solid var(--el-border-color-light);
  border-radius: 8px;
  padding: 14px 16px;
  margin-bottom: 12px;
  background: var(--el-bg-color);
}
.backup-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.backup-title {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.backup-title .icon {
  font-size: 26px;
}
.backup-title .name {
  font-weight: 600;
}
.backup-title .paths {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  word-break: break-all;
}
.backup-actions {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.quiet-setting {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
}
.sched-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 4px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}
.sched-row:last-child {
  border-bottom: none;
}
.sched-name {
  font-weight: 500;
}
.sched-cfg {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}
.backup-meta {
  margin-top: 8px;
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.backup-progress {
  margin-top: 6px;
}
</style>
