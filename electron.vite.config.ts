import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import { resolve } from 'node:path'

// 共享引擎（纯 Node，win 主进程与 linux CLI 共用同一份源码）
const coreAlias = {
  '@core': resolve(__dirname, 'packages/core/src')
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: coreAlias }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: coreAlias }
  },
  renderer: {
    plugins: [vue()],
    resolve: { alias: coreAlias },
    server: {
      // 显式绑 IPv4：localhost 在 Windows 上可能被解析成 ::1，绑定漂移会导致白屏 ERR_CONNECTION_REFUSED
      host: '127.0.0.1',
      strictPort: true
    }
  }
})
