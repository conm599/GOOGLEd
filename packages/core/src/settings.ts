import * as fs from 'node:fs'
import * as path from 'node:path'
import { DEFAULT_SETTINGS, type Settings, type AuthUserInfo } from './types'
import { getPlatform } from './platform'
import { logger } from './logger'

const SETTINGS_FILE = () => path.join(getPlatform().userDataDir(), 'settings.json')
const AUTH_FILE = () => path.join(getPlatform().userDataDir(), 'auth.json')

interface StoredTokens {
  accessToken: string
  refreshToken: string
  expiresAt: number
  user?: AuthUserInfo
}

let cache: Settings | null = null

export function loadSettings(): Settings {
  if (cache) return cache
  let s: Settings = { ...DEFAULT_SETTINGS }
  try {
    if (fs.existsSync(SETTINGS_FILE())) {
      const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf-8')) as Partial<Settings>
      s = { ...DEFAULT_SETTINGS, ...raw }
    }
  } catch (e) {
    logger.warn('settings.json 读取失败，使用默认配置', e)
  }
  if (!s.downloadDir) {
    try {
      s.downloadDir = getPlatform().downloadsDir()
    } catch {
      s.downloadDir = ''
    }
  }
  cache = s
  return s
}

export function saveSettings(s: Settings): void {
  cache = s
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true })
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(s, null, 2), 'utf-8')
  logger.info('设置已保存', { netMode: s.netMode, workerBase: s.workerBase })
}

/** token 用平台加密能力落盘（win: DPAPI / linux: AES-256-GCM 密钥文件），绝不明文保存 */
export function loadTokens(): StoredTokens | null {
  try {
    if (!fs.existsSync(AUTH_FILE())) return null
    const raw = JSON.parse(fs.readFileSync(AUTH_FILE(), 'utf-8')) as { enc?: string; plain?: StoredTokens }
    if (raw.enc) {
      const dec = getPlatform().decryptString(raw.enc)
      if (dec) return JSON.parse(dec) as StoredTokens
      logger.error('auth.json 解密失败：加密凭据无法在本机解出，请重新登录')
      return null
    }
    if (raw.plain) return raw.plain
    return null
  } catch (e) {
    logger.error('auth.json 读取失败', e)
    return null
  }
}

export function saveTokens(t: StoredTokens): void {
  const file = AUTH_FILE()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const enc = getPlatform().encryptString(JSON.stringify(t))
  if (enc) {
    fs.writeFileSync(file, JSON.stringify({ enc }), 'utf-8')
  } else {
    logger.warn('平台加密不可用，token 将以明文保存在本机（仅本机可读）')
    fs.writeFileSync(file, JSON.stringify({ plain: t }), 'utf-8')
  }
}

export function clearTokens(): void {
  try {
    fs.rmSync(AUTH_FILE(), { force: true })
  } catch {
    /* ignore */
  }
}

export type { StoredTokens }
