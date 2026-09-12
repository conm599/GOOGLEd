<template>
  <div class="page" style="max-width: 860px">
    <el-tabs>
      <!-- ============ 账号 ============ -->
      <el-tab-pane label="账号">
        <el-alert v-if="store.auth.invalid" type="error" :closable="false" show-icon style="margin-bottom: 16px"
          title="登录授权已失效：可能已在 Google 账号安全设置中移除了本应用，或长期未使用导致过期"
          description="点击「重新登录」重新授权即可恢复使用。" />
        <el-card v-if="store.auth.loggedIn" shadow="never">
          <div style="display: flex; align-items: center; gap: 12px">
            <el-avatar v-if="store.auth.user?.picture" :src="store.auth.user?.picture" />
            <el-avatar v-else>🧑</el-avatar>
            <div style="flex: 1">
              <div><b>{{ store.auth.user?.name }}</b>　<el-text type="info">{{ store.auth.user?.email }}</el-text></div>
              <el-progress v-if="quotaPercent !== null" :percentage="quotaPercent"
                :format="() => `${fmtSize(quota?.usage)} / ${fmtSize(quota?.limit)}`" style="max-width: 420px" />
            </div>
            <el-button type="warning" plain :loading="relogging" @click="relogin">重新登录</el-button>
            <el-button type="danger" plain :loading="loggingOut" @click="logout">退出登录</el-button>
          </div>
        </el-card>

        <el-card shadow="never" style="margin-top: 16px" header="OAuth 客户端凭据（你自己的 GCP 项目）">
          <el-form label-width="110px">
            <el-form-item label="客户端 ID">
              <el-input v-model="form.clientId" placeholder="xxxxx.apps.googleusercontent.com" />
            </el-form-item>
            <el-form-item label="客户端密钥">
              <el-input v-model="form.clientSecret" type="password" show-password placeholder="GOCSPX-..." />
            </el-form-item>
          </el-form>
          <el-button type="primary" plain @click="importJson">📥 导入 Google 下载的 JSON</el-button>
          <el-button @click="saveBasics">保存凭据</el-button>
          <el-button v-if="!store.auth.loggedIn" type="primary" @click="doLogin" :loading="logging">登录 Google 账号</el-button>
          <el-text v-else type="success" style="margin-left: 12px">✓ 已登录，token 将自动续期</el-text>
        </el-card>
      </el-tab-pane>

      <!-- ============ 网络 ============ -->
      <el-tab-pane label="网络">
        <el-card shadow="never">
          <el-form label-width="130px">
            <el-form-item label="网络模式">
              <el-radio-group v-model="form.netMode" @change="save">
                <el-radio value="direct">直连</el-radio>
                <el-radio value="system">系统代理</el-radio>
                <el-radio value="proxy">自定义代理</el-radio>
                <el-radio value="workers">Workers 反代</el-radio>
              </el-radio-group>
            </el-form-item>

            <template v-if="form.netMode === 'proxy'">
              <el-form-item label="代理协议">
                <el-radio-group v-model="form.proxyProtocol">
                  <el-radio value="http">HTTP</el-radio>
                  <el-radio value="socks5">SOCKS5</el-radio>
                </el-radio-group>
              </el-form-item>
              <el-form-item label="代理地址">
                <div style="display: flex; gap: 8px; align-items: center">
                  <el-input v-model="form.proxyHost" style="width: 220px" />
                  <span>:</span>
                  <el-input-number v-model="form.proxyPort" :min="1" :max="65535" />
                </div>
              </el-form-item>
            </template>

            <template v-if="form.netMode === 'workers'">
              <el-form-item label="Workers 地址">
                <div style="width: 100%; max-width: 460px">
                  <el-input v-model="form.workerBase" placeholder="https://你的-worker.workers.dev" />
                  <el-text size="small" type="info" style="margin-top: 4px; display: inline-block; line-height: 1.5">
                    同一个 Worker 绑定了多个域名就把它们全填上（逗号或换行分隔）：某个域名卡住或报错时请求会自动切到其他域名，恢复后自动切回，无需手动删除重填
                  </el-text>
                </div>
              </el-form-item>
              <el-form-item label="">
                <el-button type="primary" @click="testWorker" :loading="testing">测试连通性</el-button>
                <el-tag v-if="testResult" :type="testResult.ok ? 'success' : 'danger'" style="margin-left: 12px">
                  {{ testResult.message }}{{ testResult.latencyMs ? ` · ${testResult.latencyMs}ms` : '' }}
                </el-tag>
              </el-form-item>
            </template>

            <el-form-item label="">
              <el-button type="primary" @click="save">应用网络设置</el-button>
            </el-form-item>
          </el-form>
        </el-card>

        <el-collapse style="margin-top: 16px">
          <el-collapse-item name="deploy" title="📘 如何部署自己的 Cloudflare Workers 反代（免费，约 3 分钟）">
            <div style="line-height: 2">
              <p><b>1.</b> 注册/登录 <el-link type="primary" @click="open('https://dash.cloudflare.com/sign-up')">dash.cloudflare.com</el-link></p>
              <p><b>2.</b> 左侧「Workers 和 Pages」→「创建」→「创建 Worker」→ 随意命名 → 部署</p>
              <p><b>3.</b> 点击「编辑代码」，删除全部内容，粘贴下面的代码，再点「部署」：</p>
              <el-input type="textarea" :rows="4" :model-value="workerCode.slice(0, 400) + '\n…（完整代码见下方复制按钮）'" readonly />
              <p>
                <el-button size="small" @click="copyWorker">一键复制完整 Worker 代码</el-button>
                <el-link type="primary" style="margin-left: 12px" @click="open('https://developers.cloudflare.com/workers/get-started/dashboard/')">官方部署文档</el-link>
              </p>
              <p><b>4.</b> 把你的 Worker 地址（形如 https://xxx.workers.dev）填到上方，点「测试连通性」</p>
              <el-alert type="success" :closable="false"
                title="原理：请求经 CF 边缘节点中转到 Google，绕开直连不通的问题；免费版每天 10 万次请求，个人使用绰绰有余" />
            </div>
          </el-collapse-item>
        </el-collapse>
      </el-tab-pane>

      <!-- ============ 传输 ============ -->
      <el-tab-pane label="传输">
        <el-card shadow="never">
          <el-form label-width="160px">
            <el-form-item label="同时传输任务数">
              <el-slider v-model="form.concurrency" :min="1" :max="6" show-step style="max-width: 320px" @change="save" />
            </el-form-item>
            <el-form-item label="分块大小（MB）">
              <el-select v-model="form.chunkSizeMB" style="width: 160px" @change="save">
                <el-option v-for="n in [4, 8, 16, 32, 64]" :key="n" :value="n" :label="`${n} MB`" />
              </el-select>
              <el-text size="small" type="info" style="margin-left: 12px">网络不稳定用小块，网络好用大块</el-text>
            </el-form-item>
            <el-form-item label="下载目录">
              <el-input v-model="form.downloadDir" style="max-width: 380px" readonly />
              <el-button style="margin-left: 8px" @click="pickDir">选择…</el-button>
            </el-form-item>
            <el-form-item label="缓存">
              <div class="cache-box">
                <div class="cache-line">
                  <span>断点残留：{{ cache.orphanParts.count }} 个（{{ fmtSize(String(cache.orphanParts.bytes)) }}）</span>
                  <el-button size="small" type="danger" plain :loading="clearing" @click="clearCache">清除缓存</el-button>
                </div>
                <div class="cache-line">
                  <span>下载目录总占用：{{ fmtSize(String(cache.downloadDirBytes)) }}</span>
                  <el-text size="small" type="info">已下载文件不属于缓存，不会被自动清理</el-text>
                </div>
                <div class="cache-line">
                  <span>自动清理阈值</span>
                  <el-input-number v-model="form.cacheAutoCleanGB" :min="0" :max="1024" :step="1" style="width: 130px" @change="save" />
                  <el-text size="small" type="info">断点残留超过该 GB 数时自动清理，0 = 关闭</el-text>
                </div>
              </div>
            </el-form-item>
          </el-form>
        </el-card>
      </el-tab-pane>

      <!-- ============ 外观 ============ -->
      <el-tab-pane label="外观">
        <el-card shadow="never">
          <el-form label-width="120px">
            <el-form-item label="主题">
              <el-radio-group v-model="form.theme" @change="save">
                <el-radio value="light">浅色</el-radio>
                <el-radio value="dark">深色</el-radio>
              </el-radio-group>
            </el-form-item>
          </el-form>
        </el-card>
      </el-tab-pane>
      <!-- ============ 通用 ============ -->
      <el-tab-pane label="通用">
        <el-card shadow="never">
          <el-form label-width="120px">
            <el-form-item label="开机自启动">
              <el-switch v-model="form.autoStart" @change="save" />
              <el-text size="small" type="info" style="margin-left: 12px">开机自动启动 GOOGLEd（打包安装版生效）</el-text>
            </el-form-item>
            <el-form-item label="静默启动">
              <div style="display: flex; align-items: center; gap: 12px">
                <el-switch v-model="form.autoStartHidden" :disabled="!form.autoStart" @change="save" />
                <el-text size="small" type="info">开机后不弹主窗口，直接最小化到系统托盘后台运行（备份/传输照常工作）</el-text>
              </div>
            </el-form-item>
          </el-form>
        </el-card>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useAppStore } from '../stores/app'
import { fmtSize } from '../utils/format'
import { withToast, plain } from '../utils/action'

const store = useAppStore()
const logging = ref(false)
const loggingOut = ref(false)
const relogging = ref(false)
const testing = ref(false)
const testResult = ref<{ ok: boolean; message: string; latencyMs?: number } | null>(null)
const workerCode = ref('')

const form = reactive({
  clientId: '',
  clientSecret: '',
  netMode: 'direct' as 'direct' | 'system' | 'proxy' | 'workers',
  proxyProtocol: 'http' as 'http' | 'socks5',
  proxyHost: '127.0.0.1',
  proxyPort: 7890,
  workerBase: '',
  concurrency: 3,
  chunkSizeMB: 16,
  downloadDir: '',
  cacheAutoCleanGB: 0,
  autoStart: false,
  autoStartHidden: false,
  theme: 'light' as 'light' | 'dark'
})

const cache = ref<{ orphanParts: { count: number; bytes: number }; downloadDirBytes: number; downloadDir: string }>({
  orphanParts: { count: 0, bytes: 0 },
  downloadDirBytes: 0,
  downloadDir: ''
})
const clearing = ref(false)

async function loadCache(): Promise<void> {
  try {
    cache.value = await window.api.cacheStats()
  } catch {
    /* ignore */
  }
}

async function clearCache(): Promise<void> {
  clearing.value = true
  try {
    const r = await window.api.cacheClear()
    ElMessage.success(r.count ? `已清理 ${r.count} 个断点残留，释放 ${fmtSize(String(r.freed))}` : '没有可清理的缓存')
    await loadCache()
  } finally {
    clearing.value = false
  }
}

const localQuota = ref<{ limit?: string; usage?: string } | null>(null)
const quota = computed(() => localQuota.value)
const quotaPercent = computed<number | null>(() => {
  const q = quota.value
  if (!q?.limit || !q?.usage) return null
  return Math.round((parseInt(q.usage, 10) / parseInt(q.limit, 10)) * 100)
})

onMounted(async () => {
  const s = await window.api.getSettings()
  Object.assign(form, s)
  form.clientSecret = s.clientSecret
  void loadCache()
  void window.api.getWorkerTemplate().then((c) => (workerCode.value = c))
  if (store.auth.loggedIn) {
    try {
      const about = await window.api.driveAbout()
      localQuota.value = about.storageQuota || null
    } catch {
      /* ignore */
    }
  }
})

async function save(): Promise<void> {
  await withToast(async () => {
    // form 里 workerHosts 是数组，reactive 读取时是 Proxy，必须在跨 contextBridge 前纯化
    await window.api.updateSettings(plain({ ...form }))
    ElMessage.success('已保存')
  }, '保存失败')
}

async function saveBasics(): Promise<void> {
  await withToast(async () => {
    await window.api.updateSettings({ clientId: form.clientId.trim(), clientSecret: form.clientSecret.trim() })
    await store.refreshAuth()
    ElMessage.success('凭据已保存')
  }, '保存失败')
}

async function importJson(): Promise<void> {
  const r = await window.api.importClientJson()
  if (!r.ok) {
    ElMessage.warning(r.message)
    return
  }
  ElMessage.success(r.message)
  const s = await window.api.getSettings()
  form.clientId = s.clientId
  form.clientSecret = s.clientSecret
  await store.refreshAuth()
}

async function doLogin(): Promise<void> {
  logging.value = true
  try {
    await window.api.login()
    await store.refreshAuth()
    ElMessage.success('登录成功！')
  } catch (e) {
    ElMessage.error(`登录失败：${(e as Error).message}`)
  } finally {
    logging.value = false
  }
}

async function logout(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      '将清除本机保存的凭据，并撤销 GOOGLEd 在你 Google 账号中的授权。撤销后如需再次使用须重新登录。',
      '退出登录',
      { type: 'warning', confirmButtonText: '退出登录', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  loggingOut.value = true
  try {
    await window.api.logout()
    await store.refreshAuth()
    ElMessage.success('已退出登录')
  } catch (e) {
    ElMessage.error(`退出失败：${(e as Error).message}`)
  } finally {
    loggingOut.value = false
  }
}

async function relogin(): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `将清除账号（${store.auth.user?.email || '当前账号'}）的现有授权并重新走一遍 Google 授权流程，你也可以借此切换到其他账号。`,
      '重新登录',
      { type: 'warning', confirmButtonText: '重新授权', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  relogging.value = true
  try {
    const st = await window.api.relogin()
    await store.refreshAuth()
    ElMessage.success(`重新登录成功：${st.user?.email || '已完成授权'}`)
  } catch (e) {
    ElMessage.error(`重新登录失败：${(e as Error).message}`)
  } finally {
    relogging.value = false
  }
}

async function testWorker(): Promise<void> {
  await save()
  testing.value = true
  testResult.value = null
  try {
    testResult.value = await window.api.testWorker()
  } catch (e) {
    testResult.value = { ok: false, message: (e as Error).message }
  } finally {
    testing.value = false
  }
}

async function pickDir(): Promise<void> {
  try {
    const dir = await window.api.pickDownloadDir()
    if (dir) {
      form.downloadDir = dir
      await save()
    }
  } catch (e) {
    ElMessage.error(`选择目录失败：${(e as Error).message}`)
  }
}

async function copyWorker(): Promise<void> {
  await navigator.clipboard.writeText(workerCode.value)
  ElMessage.success('Worker 代码已复制，去 Cloudflare 编辑器粘贴部署')
}

function open(url: string): void {
  void window.api.openExternal(url)
}
</script>

<style scoped>
.cache-box {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 560px;
}
.cache-line {
  display: flex;
  align-items: center;
  gap: 12px;
  justify-content: space-between;
}
</style>
