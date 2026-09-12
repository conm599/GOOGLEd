<template>
  <div v-if="!store.auth.configured" style="max-width: 760px; margin: 40px auto; padding: 0 20px">
    <el-result icon="info" title="欢迎使用 GOOGLEd 云盘" sub-title="一个为中文用户打造的 Google 云盘桌面客户端：断点续传、Workers 反代加速">
      <template #extra>
        <el-button type="primary" size="large" @click="show = true">开始配置（约 5 分钟）</el-button>
      </template>
    </el-result>

    <el-dialog v-model="show" title="首次配置向导" width="720px">
      <el-steps :active="step" align-center finish-status="success">
        <el-step title="创建凭据" description="Google Cloud 控制台" />
        <el-step title="粘贴凭据" description="Client ID / Secret" />
        <el-step title="网络设置" description="直连 / 代理 / Workers" />
      </el-steps>

      <div v-if="step === 0" style="line-height: 2; margin-top: 20px">
        <p><b>1.</b> 启用 Drive API —— <b>你已经完成了</b>（你看到的「已启用」页面就是这步）✅</p>
        <p><b>2.</b> 就在那个页面，点<b>右上角「创建凭据」按钮</b> → 选「<b>OAuth 客户端 ID</b>」</p>
        <p><b>3.</b> 第一次会跳到「配置同意屏幕」：选 <b>外部</b> → 应用名随意填 → 一路保存；
           在「测试用户」里<b>添加你自己的 Gmail</b></p>
        <p><b>4.</b> 回到「客户端」页 →「创建客户端」→ 应用类型选 <b>桌面应用</b> → 创建</p>
        <p><b>5.</b> 弹窗里点「<b>下载 JSON</b>」保存到电脑 —— <b>密钥就在这个 JSON 里，不用手动复制</b></p>
        <p><b>6.</b> 下一步里点「一键导入 JSON」选中刚下载的文件，搞定</p>
        <el-alert type="success" :closable="false" style="margin-top: 8px"
          title="密钥不是「启用 API」后直接给的，而是「创建 OAuth 客户端」之后才生成，藏在下载的 JSON 里" />
        <el-alert type="warning" :closable="false" style="margin-top: 8px"
          title="登录若提示 403 access_denied：去控制台「Google Auth Platform → 受众」点「发布应用」切成正式模式（个人使用推荐，一劳永逸）；或在「测试用户」里添加你要登录的那个 Gmail。注意：谁登录就把谁加进去，不是只加项目所有者" />
      </div>

      <div v-else-if="step === 1" style="margin-top: 20px">
        <el-button type="primary" size="large" style="width: 100%" @click="importJson">
          📥 一键导入 Google 下载的 JSON（推荐）
        </el-button>
        <el-divider>或者手动粘贴</el-divider>
        <el-form label-width="120px">
          <el-form-item label="客户端 ID">
            <el-input v-model="clientId" placeholder="xxxxx.apps.googleusercontent.com" />
          </el-form-item>
          <el-form-item label="客户端密钥">
            <el-input v-model="clientSecret" type="password" show-password placeholder="GOCSPX-..." />
          </el-form-item>
        </el-form>
        <el-alert type="warning" :closable="false"
          title="凭据保存在你本机，仅用于你自己的账号登录，请勿泄露给他人" />
      </div>

      <div v-else style="margin-top: 20px">
        <el-form label-width="120px">
          <el-form-item label="网络模式">
            <el-radio-group v-model="netMode">
              <el-radio value="direct">直连（本机已可翻墙）</el-radio>
              <el-radio value="proxy">自定义代理</el-radio>
              <el-radio value="workers">Workers 反代</el-radio>
            </el-radio-group>
          </el-form-item>
          <template v-if="netMode === 'proxy'">
            <el-form-item label="代理协议">
              <el-radio-group v-model="proxyProtocol">
                <el-radio value="http">HTTP</el-radio>
                <el-radio value="socks5">SOCKS5</el-radio>
              </el-radio-group>
            </el-form-item>
            <el-form-item label="代理地址">
              <el-input v-model="proxyHost" style="width: 220px" placeholder="127.0.0.1" />
              <span style="margin: 0 8px">:</span>
              <el-input v-model="proxyPort" style="width: 100px" placeholder="7890" />
            </el-form-item>
          </template>
          <el-form-item v-if="netMode === 'workers'" label="Workers 地址">
            <el-input v-model="workerBase" placeholder="https://你的-worker.workers.dev" />
          </el-form-item>
        </el-form>
        <el-alert v-if="netMode === 'workers'" type="info" :closable="false"
          title="还没有部署 Workers？到「设置 → 网络」里有一键复制部署脚本和详细教程" />
      </div>

      <template #footer>
        <el-button v-if="step > 0" @click="step--">上一步</el-button>
        <el-button v-if="step < 2" type="primary" @click="step++">下一步</el-button>
        <el-button v-else type="primary" @click="finish">保存并登录</el-button>
      </template>
    </el-dialog>
  </div>
  <div v-else-if="store.auth.invalid" style="max-width: 760px; margin: 40px auto; padding: 0 20px">
    <el-result icon="warning" title="登录已失效"
      :sub-title="`账号 ${store.auth.user?.email || ''} 的授权已被撤销或已过期，需要重新登录`">
      <template #extra>
        <el-button type="primary" size="large" :loading="busy" @click="doRelogin">重新登录</el-button>
      </template>
    </el-result>
  </div>
  <div v-else-if="!store.auth.loggedIn" style="max-width: 760px; margin: 40px auto; padding: 0 20px">
    <el-result icon="info" title="尚未登录 Google 账号" sub-title="登录后即可浏览、上传和下载云盘文件">
      <template #extra>
        <el-button type="primary" size="large" :loading="busy" @click="doLogin">登录 Google 账号</el-button>
      </template>
    </el-result>
  </div>
  <slot v-else />
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useAppStore } from '../stores/app'
import { ElMessage } from 'element-plus'

const store = useAppStore()
const show = ref(false)
const busy = ref(false)
const step = ref(0)
const clientId = ref('')
const clientSecret = ref('')
const netMode = ref('direct')
const proxyProtocol = ref('http')
const proxyHost = ref('127.0.0.1')
const proxyPort = ref('7890')
const workerBase = ref('')

function open(url: string): void {
  void window.api.openExternal(url)
}

async function doLogin(): Promise<void> {
  busy.value = true
  try {
    await window.api.login()
    await store.refreshAuth()
    ElMessage.success('登录成功！')
  } catch (e) {
    ElMessage.error(`登录失败：${(e as Error).message}`)
  } finally {
    busy.value = false
  }
}

async function doRelogin(): Promise<void> {
  busy.value = true
  try {
    await window.api.relogin()
    await store.refreshAuth()
    ElMessage.success('重新登录成功！')
  } catch (e) {
    ElMessage.error(`重新登录失败：${(e as Error).message}`)
  } finally {
    busy.value = false
  }
}

async function importJson(): Promise<void> {
  const r = await window.api.importClientJson()
  if (!r.ok) {
    ElMessage.warning(r.message)
    return
  }
  ElMessage.success(r.message)
  await store.refreshAuth()
  show.value = false
  try {
    await window.api.login()
    await store.refreshAuth()
    ElMessage.success('登录成功！')
  } catch (e) {
    ElMessage.error(`登录失败：${(e as Error).message}`)
  }
}

async function finish(): Promise<void> {
  if (!clientId.value || !clientSecret.value) {
    ElMessage.warning('请填写完整的客户端 ID 和密钥')
    return
  }
  const patch: Record<string, unknown> = {
    clientId: clientId.value.trim(),
    clientSecret: clientSecret.value.trim()
  }
  if (netMode.value === 'proxy') {
    patch.netMode = 'proxy'
    patch.proxyProtocol = proxyProtocol.value
    patch.proxyHost = proxyHost.value.trim()
    patch.proxyPort = parseInt(proxyPort.value, 10) || 7890
  } else if (netMode.value === 'workers') {
    if (!workerBase.value.trim()) {
      ElMessage.warning('请填写 Workers 地址')
      return
    }
    patch.netMode = 'workers'
    patch.workerBase = workerBase.value.trim()
  } else {
    patch.netMode = 'direct'
  }
  await window.api.updateSettings(patch)
  await store.refreshAuth()
  show.value = false
  try {
    await window.api.login()
    await store.refreshAuth()
    ElMessage.success('登录成功！')
  } catch (e) {
    ElMessage.error(`登录失败：${(e as Error).message}`)
  }
}
</script>
