<template>
  <el-dialog v-model="visible" :title="title" width="560px" @opened="load">
    <!-- 面包屑 -->
    <el-breadcrumb style="margin-bottom: 10px; font-size: 13px">
      <el-breadcrumb-item v-for="(c, i) in crumbs" :key="c.id">
        <el-link :underline="false" @click="goTo(i)">{{ c.name }}</el-link>
      </el-breadcrumb-item>
    </el-breadcrumb>

    <!-- 文件夹列表（Windows 资源管理器风格：双击进入） -->
    <div class="fp-list" v-loading="loading">
      <div
        v-for="f in folders"
        :key="f.id"
        class="fp-item"
        :class="{ active: currentId === f.id }"
        @dblclick="enter(f)"
      >
        <span style="font-size: 18px">📁</span>
        <span style="flex: 1">{{ f.name }}</span>
        <el-tag v-if="currentId === f.id" size="small" type="primary">已选择</el-tag>
      </div>
      <div v-if="!loading && !folders.length" class="fp-empty">此文件夹没有子文件夹</div>
    </div>

    <template #footer>
      <div style="display: flex; justify-content: space-between; align-items: center">
        <el-button size="small" @click="newFolder" :disabled="loading">新建文件夹</el-button>
        <div>
          <el-button @click="visible = false">取消</el-button>
          <el-button type="primary" :disabled="loading" @click="confirm">
            选择「{{ currentName }}」
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { DriveFile } from '../../../shared/types'

const props = defineProps<{ title?: string }>()
const visible = defineModel<boolean>({ default: false })
const emit = defineEmits<{ picked: [{ id: string; name: string }] }>()

interface Crumb {
  id: string
  name: string
}

const crumbs = ref<Crumb[]>([{ id: 'root', name: '我的云盘' }])
const folders = ref<DriveFile[]>([])
const loading = ref(false)
const currentId = computed(() => crumbs.value[crumbs.value.length - 1].id)
const currentName = computed(() => crumbs.value[crumbs.value.length - 1].name)

watch(visible, (v) => {
  if (v) {
    crumbs.value = [{ id: 'root', name: '我的云盘' }]
    void load()
  }
})

function open(): void {
  visible.value = true
}

defineExpose({ open })

async function load(): Promise<void> {
  loading.value = true
  try {
    const r = await window.api.driveList({ parentId: currentId.value, pageSize: 200, trashed: false })
    folders.value = r.files.filter((f) => f.mimeType === 'application/vnd.google-apps.folder')
  } catch (e) {
    ElMessage.error(`加载失败：${(e as Error).message}`)
  } finally {
    loading.value = false
  }
}

function enter(f: DriveFile): void {
  crumbs.value.push({ id: f.id, name: f.name })
  void load()
}

function goTo(i: number): void {
  crumbs.value = crumbs.value.slice(0, i + 1)
  void load()
}

async function newFolder(): Promise<void> {
  try {
    const r = await ElMessageBox.prompt('输入文件夹名称', '新建文件夹', { inputValue: '新建文件夹' })
    const name = r.value?.trim()
    if (!name) return
    const folder = await window.api.createFolder(name, currentId.value)
    ElMessage.success('已创建')
    crumbs.value.push({ id: folder.id, name: folder.name })
    await load()
  } catch {
    /* 用户取消 */
  }
}

function confirm(): void {
  emit('picked', { id: currentId.value, name: currentName.value })
  visible.value = false
}
</script>

<style scoped>
.fp-list {
  min-height: 260px;
  max-height: 46vh;
  overflow: auto;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  padding: 4px;
}
.fp-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 5px;
  cursor: pointer;
  user-select: none;
}
.fp-item:hover {
  background: var(--el-fill-color-light);
}
.fp-item.active {
  background: var(--el-color-primary-light-9);
}
.fp-empty {
  text-align: center;
  color: var(--el-text-color-secondary);
  padding: 40px 0;
  font-size: 13px;
}
</style>
