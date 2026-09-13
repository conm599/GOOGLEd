<template>
  <el-dialog v-model="visible" :title="file?.name || '预览'" width="82%" top="3vh" destroy-on-close>
    <div class="preview-body">
      <!-- 视频：西瓜播放器 -->
      <div v-if="kind === 'video'" class="video-wrap">
        <div :id="playerDomId" class="player-box" />
        <div v-if="mediaError" class="media-retry">
          <span>视频加载失败（网络波动）</span>
          <el-button size="small" type="primary" @click="retryMedia">重试</el-button>
        </div>
      </div>
      <!-- 音频：原生 audio，流式 + 拖进度 -->
      <div v-else-if="kind === 'audio'" class="audio-box">
        <div class="audio-icon">🎵</div>
        <div class="audio-name">{{ file?.name }}</div>
        <audio controls :src="mediaUrl" style="width: 100%" @error="mediaError = true" />
        <div v-if="mediaError" class="media-retry">
          <span>音频加载失败（网络波动）</span>
          <el-button size="small" type="primary" @click="retryMedia">重试</el-button>
        </div>
      </div>
      <!-- 图片 -->
      <div v-else-if="kind === 'image'" class="image-box">
        <img v-if="!mediaError" :src="mediaUrl" :alt="file?.name" @error="mediaError = true" />
        <div v-else class="media-retry">
          <span>图片加载失败</span>
          <el-button size="small" type="primary" @click="retryMedia">重试</el-button>
        </div>
      </div>
      <!-- PDF：Chromium 内置查看器 -->
      <iframe v-else-if="kind === 'pdf'" :src="mediaUrl" class="pdf-frame" />
      <!-- 文本 -->
      <pre v-else-if="kind === 'text'" class="text-box">{{ text }}</pre>
      <!-- Word docx -->
      <div v-else-if="kind === 'docx'" class="docx-wrap">
        <div v-if="docxLoading" v-loading="true" class="docx-loading" element-loading-text="正在渲染文档…" />
        <div ref="docxEl" class="docx-box" />
      </div>
      <!-- 不支持 -->
      <div v-else class="unsupported-box">
        <el-empty description="该格式不支持在线预览，请下载后打开">
          <el-button type="primary" @click="emit('download')">下载到本地</el-button>
        </el-empty>
      </div>
    </div>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import Player from 'xgplayer'
import 'xgplayer/dist/index.min.css'
import { renderAsync } from 'docx-preview'
import type { DriveFile } from '@core/types'

const props = defineProps<{ file: DriveFile | null }>()
const visible = defineModel<boolean>({ default: false })
const emit = defineEmits<{ download: [] }>()

type Kind = 'video' | 'audio' | 'image' | 'pdf' | 'text' | 'docx' | 'unsupported'
const VIDEO_EXT = ['mp4', 'webm', 'm4v', 'mov']
const AUDIO_EXT = ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac', 'opus']
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico']
const TEXT_EXT = ['txt', 'md', 'json', 'js', 'ts', 'css', 'html', 'xml', 'yml', 'yaml', 'csv', 'log', 'ini', 'conf', 'sh', 'bat', 'py', 'sql', 'vue']

const kind = computed<Kind>(() => {
  const f = props.file
  if (!f) return 'unsupported'
  const name = f.name.toLowerCase()
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : ''
  const mime = f.mimeType || ''
  if (mime.startsWith('video/') || VIDEO_EXT.includes(ext)) return 'video'
  if (mime.startsWith('audio/') || AUDIO_EXT.includes(ext)) return 'audio'
  if (mime.startsWith('image/') || IMAGE_EXT.includes(ext)) return 'image'
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf'
  if (ext === 'docx' || mime.includes('wordprocessingml.document')) return 'docx'
  if (mime.startsWith('text/') || TEXT_EXT.includes(ext)) return 'text'
  return 'unsupported'
})

const mediaUrl = computed(() => (props.file ? `gd://media/${props.file.id}${bust.value ? `?r=${bust.value}` : ''}` : ''))

const mediaError = ref(false)
const bust = ref(0)
const playerDomId = `xg-player-${Math.random().toString(36).slice(2)}`
const docxEl = ref<HTMLElement>()
const docxLoading = ref(false)
const text = ref('')
let player: Player | null = null

function retryMedia(): void {
  mediaError.value = false
  bust.value++
  if (kind.value === 'video') {
    destroyPlayer()
    void nextTick(createPlayer)
  }
}

function createPlayer(): void {
  if (!mediaUrl.value) return
  player = new Player({
    id: playerDomId,
    url: mediaUrl.value,
    width: '100%',
    height: '100%',
    autoplay: false,
    volume: 0.8,
    enableContextMenu: false
  })
  player.on('error', () => {
    mediaError.value = true
  })
}

function destroyPlayer(): void {
  player?.destroy()
  player = null
}

watch(
  [visible, kind],
  async ([v]) => {
    if (!v) {
      destroyPlayer()
      return
    }
    if (!props.file) return
    mediaError.value = false
    await nextTick()
    if (kind.value === 'video' && !player) {
      createPlayer()
    }
    if (kind.value === 'text') {
      text.value = '加载中…'
      try {
        text.value = await window.api.readText(props.file.id)
      } catch (e) {
        text.value = `加载失败：${(e as Error).message}`
      }
    }
    if (kind.value === 'docx' && docxEl.value) {
      docxLoading.value = true
      try {
        const buf = await fetch(mediaUrl.value).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`)
          return r.arrayBuffer()
        })
        await renderAsync(buf, docxEl.value, undefined, { inWrapper: true, breakPages: true })
      } catch (e) {
        docxEl.value.innerText = `渲染失败：${(e as Error).message}`
      } finally {
        docxLoading.value = false
      }
    }
  },
  { immediate: true }
)

onBeforeUnmount(destroyPlayer)
</script>

<style scoped>
.preview-body {
  min-height: 320px;
  display: flex;
  flex-direction: column;
}
.player-box {
  width: 100%;
  aspect-ratio: 16 / 9;
  background: #000;
}
.video-wrap {
  position: relative;
}
.media-retry {
  display: flex;
  align-items: center;
  gap: 12px;
  justify-content: center;
  padding: 10px;
  color: var(--el-color-danger);
  font-size: 13px;
}
.audio-box {
  padding: 30px 10px;
  text-align: center;
}
.audio-icon {
  font-size: 56px;
  margin-bottom: 12px;
}
.audio-name {
  margin-bottom: 18px;
  color: var(--el-text-color-secondary);
}
.image-box {
  display: flex;
  justify-content: center;
}
.image-box img {
  max-width: 100%;
  max-height: 70vh;
}
.pdf-frame {
  width: 100%;
  height: 76vh;
  border: none;
}
.text-box {
  margin: 0;
  padding: 14px;
  max-height: 70vh;
  overflow: auto;
  background: var(--el-fill-color-light);
  border-radius: 6px;
  font-family: Consolas, 'Courier New', monospace;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}
.docx-wrap {
  min-height: 320px;
}
.docx-loading {
  height: 320px;
}
.docx-box {
  max-height: 74vh;
  overflow: auto;
}
.unsupported-box {
  padding: 40px 0;
}
</style>
