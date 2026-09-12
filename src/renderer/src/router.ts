import { createRouter, createWebHashHistory } from 'vue-router'

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'files', component: () => import('./views/FilesView.vue') },
    { path: '/transfers', name: 'transfers', component: () => import('./views/TransfersView.vue') },
    { path: '/backup', name: 'backup', component: () => import('./views/BackupView.vue') },
    { path: '/shares', name: 'shares', component: () => import('./views/SharesView.vue') },
    { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue') }
  ]
})
