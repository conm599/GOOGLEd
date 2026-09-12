import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { Settings, TransferTask, AuthStatus } from '../../../shared/types'

export const useAppStore = defineStore('app', () => {
  const settings = ref<Settings | null>(null)
  const auth = ref<AuthStatus>({ configured: false, loggedIn: false })
  const tasks = ref<TransferTask[]>([])

  async function loadAll(): Promise<void> {
    settings.value = await window.api.getSettings()
    await refreshAuth()
    tasks.value = await window.api.transferList()
    window.api.onTransferChanged((t) => {
      tasks.value = t
    })
    window.api.onSettingsChanged((s) => {
      settings.value = s
      applyTheme()
    })
    window.api.onAuthChanged((s) => {
      auth.value = s
    })
    applyTheme()
  }

  function applyTheme(): void {
    document.documentElement.classList.toggle('dark', settings.value?.theme === 'dark')
  }

  async function refreshAuth(): Promise<void> {
    auth.value = await window.api.authStatus()
  }

  const activeCount = (): number => tasks.value.filter((t) => t.status === 'running' || t.status === 'queued').length

  return { settings, auth, tasks, loadAll, refreshAuth, applyTheme, activeCount }
})
