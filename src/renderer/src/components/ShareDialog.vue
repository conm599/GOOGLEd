<template>
  <el-dialog v-model="visible" :title="`分享「${file?.name}」`" width="560px">
    <template v-if="!link">
      <p style="margin-top: 0">创建一个知道链接即可访问的分享：</p>
      <el-radio-group v-model="role">
        <el-radio value="reader">任何人可查看</el-radio>
        <el-radio value="writer">任何人可编辑</el-radio>
      </el-radio-group>
      <div style="margin-top: 16px; display: flex; gap: 8px">
        <el-button type="primary" :loading="creating" @click="create">创建分享链接</el-button>
      </div>
    </template>
    <template v-else>
      <el-alert type="success" :closable="false" title="分享已开启" />
      <el-input :model-value="link" readonly style="margin: 12px 0">
        <template #append>
          <el-button @click="copy">复制</el-button>
        </template>
      </el-input>
      <el-button type="danger" plain :loading="revoking" @click="revoke">取消分享</el-button>
    </template>

    <el-divider>已有权限</el-divider>
    <div v-if="perms.length">
      <div v-for="p in perms" :key="p.id" style="display: flex; justify-content: space-between; align-items: center; padding: 4px 0">
        <span>
          <el-tag size="small" style="margin-right: 8px">{{ roleText(p) }}</el-tag>
          {{ p.displayName || p.emailAddress || '任何知道链接的人' }}
        </span>
        <el-button v-if="p.type === 'anyone'" size="small" text type="danger" @click="removePerm(p.id)">移除</el-button>
      </div>
    </div>
    <el-empty v-else description="暂无其他权限" :image-size="60" />
  </el-dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { ElMessage } from 'element-plus'
import type { DriveFile, DrivePermission } from '../../../shared/types'
import { isFolder } from '../utils/format'
import { withToast } from '../utils/action'

const visible = defineModel<boolean>({ default: false })
const props = defineProps<{ file: DriveFile | null }>()
const emit = defineEmits<{ changed: [] }>()

const link = ref('')
const role = ref<'reader' | 'writer'>('reader')
const perms = ref<DrivePermission[]>([])
const creating = ref(false)
const revoking = ref(false)

watch(visible, async (v) => {
  if (v && props.file) {
    link.value = ''
    role.value = 'reader'
    await loadPerms()
    // 已经是公开分享的直接展示链接
    if (perms.value.some((p) => p.type === 'anyone')) {
      link.value = linkFor(props.file.id)
    }
  }
})

/** 文件夹和文件的分享链接格式不同 */
function linkFor(id: string): string {
  if (props.file && isFolder(props.file.mimeType)) {
    return `https://drive.google.com/drive/folders/${id}?usp=sharing`
  }
  return `https://drive.google.com/file/d/${id}/view?usp=sharing`
}

async function loadPerms(): Promise<void> {
  if (!props.file) return
  try {
    perms.value = await window.api.listPermissions(props.file.id)
  } catch (e) {
    ElMessage.error(`获取权限失败：${(e as Error).message}`)
  }
}

async function create(): Promise<void> {
  if (!props.file) return
  creating.value = true
  try {
    await window.api.createShareLink(props.file.id, role.value)
    link.value = linkFor(props.file.id)
    await loadPerms()
    emit('changed')
    ElMessage.success('已创建分享链接')
  } catch (e) {
    ElMessage.error(`创建失败：${(e as Error).message}`)
  } finally {
    creating.value = false
  }
}

async function revoke(): Promise<void> {
  if (!props.file) return
  revoking.value = true
  try {
    await window.api.revokeShare(props.file.id)
    link.value = ''
    await loadPerms()
    emit('changed')
    ElMessage.success('已取消分享')
  } catch (e) {
    ElMessage.error(`取消失败：${(e as Error).message}`)
  } finally {
    revoking.value = false
  }
}

async function removePerm(permId: string): Promise<void> {
  if (!props.file) return
  try {
    await window.api.deletePermission(props.file.id, permId)
    link.value = ''
    await loadPerms()
    emit('changed')
  } catch (e) {
    ElMessage.error(`移除失败：${(e as Error).message}`)
  }
}

async function copy(): Promise<void> {
  await withToast(async () => {
    await navigator.clipboard.writeText(link.value)
    ElMessage.success('已复制到剪贴板')
  }, '复制失败')
}

function roleText(p: DrivePermission): string {
  if (p.type === 'anyone') return p.role === 'writer' ? '任何人可编辑' : '任何人可查看'
  if (p.type === 'user' || p.type === 'group') return p.role === 'owner' ? '所有者' : '指定用户'
  if (p.type === 'domain') return '域内用户'
  return p.type
}
</script>
