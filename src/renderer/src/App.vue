<template>
  <div class="layout">
    <aside class="sidebar">
      <div class="logo">
        <span>☁️</span>
        <div>
          GOOGLEd
          <div class="sub">断点续传 · 中国加速</div>
        </div>
      </div>
      <el-menu :default-active="route.path" router style="border-right: none">
        <el-menu-item index="/">
          <el-icon><FolderOpened /></el-icon>文件
        </el-menu-item>
        <el-menu-item index="/transfers">
          <el-icon><Sort /></el-icon>
          <template #title>
            传输
            <el-badge v-if="activeCount" :value="activeCount" style="margin-left: 6px" />
          </template>
        </el-menu-item>
        <el-menu-item index="/backup">
          <el-icon><Box /></el-icon>备份
        </el-menu-item>
        <el-menu-item index="/trash">
          <el-icon><Delete /></el-icon>回收站
        </el-menu-item>
        <el-menu-item index="/settings">
          <el-icon><Setting /></el-icon>设置
        </el-menu-item>
      </el-menu>
      <div class="quota-bar" v-if="store.auth.loggedIn">
        <el-text size="small" type="info">{{ store.auth.user?.email }}</el-text>
      </div>
    </aside>
    <main class="main">
      <WelcomeGate v-if="ready">
        <router-view :key="route.path" />
      </WelcomeGate>
    </main>
    <UpdateDialog ref="updateDialog" />
  </div>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, computed } from 'vue'
import { useRoute } from 'vue-router'
import { FolderOpened, Sort, Setting, Box, Delete } from '@element-plus/icons-vue'
import { useAppStore } from './stores/app'
import WelcomeGate from './components/WelcomeGate.vue'
import UpdateDialog from './components/UpdateDialog.vue'

const route = useRoute()
const store = useAppStore()
const ready = ref(false)
const activeCount = computed(() => store.activeCount())
const updateDialog = ref<InstanceType<typeof UpdateDialog>>()
let offUpdateAvailable: (() => void) | undefined

onMounted(async () => {
  await store.loadAll()
  ready.value = true
  offUpdateAvailable = window.api.onUpdateAvailable((info) => updateDialog.value?.show(info))
})
onBeforeUnmount(() => offUpdateAvailable?.())
</script>
