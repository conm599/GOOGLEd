import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [vue()],
    server: {
      // 显式绑 IPv4：localhost 在 Windows 上可能被解析成 ::1，绑定漂移会导致白屏 ERR_CONNECTION_REFUSED
      host: '127.0.0.1',
      strictPort: true
    }
  }
})
