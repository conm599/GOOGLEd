import { BrowserWindow, session, shell } from 'electron'
import * as http from 'node:http'
import * as crypto from 'node:crypto'
import { netClient } from '../net/NetClient'
import { loadSettings, loadTokens, saveTokens, clearTokens, type StoredTokens } from '../settings'
import { logger } from '../logger'
import type { AuthStatus, AuthUserInfo } from '../../shared/types'

const SCOPE = 'https://www.googleapis.com/auth/drive openid email profile'

/**
 * 标准 OAuth2（桌面应用 loopback 流程）：
 * 浏览器授权 → 本地 127.0.0.1 回调收 code → 换 token → safeStorage 加密存储 → refresh token 长期自动续期。
 * token 换取与刷新都走 NetClient，因此在代理 / Workers 模式下同样可用。
 */
class AuthService {
  private refreshing: Promise<void> | null = null
  /** refresh token 已失效（被撤销/过期），需要重新走授权 */
  private invalidGrant = false

  status(): AuthStatus {
    const s = loadSettings()
    const t = loadTokens()
    const loggedIn = !!(t && t.refreshToken)
    return {
      configured: !!(s.clientId && s.clientSecret),
      loggedIn,
      user: t?.user,
      invalid: loggedIn && this.invalidGrant
    }
  }

  async login(): Promise<AuthUserInfo> {
    const s = loadSettings()
    if (!s.clientId || !s.clientSecret) throw new Error('请先在设置中填写 OAuth 客户端 ID 和密钥')

    const port = await this.listenLoopback()
    const redirectUri = `http://127.0.0.1:${port}`
    const state = crypto.randomBytes(16).toString('hex')

    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    authUrl.searchParams.set('client_id', s.clientId)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('scope', SCOPE)
    authUrl.searchParams.set('access_type', 'offline')
    authUrl.searchParams.set('prompt', 'consent')
    authUrl.searchParams.set('state', state)

    // 先挂好回调监听，再打开登录窗口（顺序不能反，否则会永久等待）
    const codePromise = this.waitLoopbackCode(port, state)
    await this.openAuthWindow(authUrl.toString())
    const code = await codePromise

    const tokens = await this.exchangeCode(s.clientId, s.clientSecret, code, redirectUri)
    const user = await this.fetchUser(tokens.accessToken)
    saveTokens({ ...tokens, user })
    this.invalidGrant = false
    logger.info('登录成功', user)
    this.broadcastAuth()
    return user
  }

  /** 重新登录：撤销并清除现有凭据，重新走完整授权流程（用于授权失效恢复或切换账号） */
  async relogin(): Promise<AuthUserInfo> {
    await this.logout()
    return this.login()
  }

  /**
   * 退出登录：
   * 1. 调 Google revoke 撤销服务端授权（尽力而为，失败不阻塞退出）
   * 2. 清除本机加密凭据
   * 3. 清空内嵌登录窗口的会话，下次登录会要求重新选账号，不会被旧登录态带偏
   */
  async logout(): Promise<void> {
    const t = loadTokens()
    if (t?.refreshToken || t?.accessToken) await this.revokeToken(t.refreshToken || t.accessToken)
    clearTokens()
    this.invalidGrant = false
    this.authWindow?.close()
    await this.clearAuthSession()
    logger.info('已退出登录')
    this.broadcastAuth()
  }

  private async revokeToken(token: string): Promise<void> {
    try {
      await netClient.request('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `token=${encodeURIComponent(token)}`
      })
      logger.info('已撤销 Google 端授权')
    } catch (e) {
      logger.warn('授权撤销失败（忽略，继续本地退出）', (e as Error).message)
    }
  }

  private async clearAuthSession(): Promise<void> {
    try {
      await session.fromPartition('persist:googled-auth').clearStorageData()
    } catch (e) {
      logger.warn('清理登录窗口会话失败', e)
    }
  }

  /** 登录状态变化推送给所有窗口（登录/退出/授权失效时） */
  private broadcastAuth(): void {
    const status = this.status()
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('auth:changed', status)
    }
  }

  /** 获取有效 access token，过期前 60s 自动刷新；并发刷新只发一次请求 */
  async getAccessToken(): Promise<string> {
    let t = loadTokens()
    if (!t || !t.refreshToken) throw new Error('未登录')
    if (t.expiresAt - Date.now() > 60_000) return t.accessToken
    if (!this.refreshing) {
      this.refreshing = this.doRefresh()
        .catch((e) => {
          logger.error('token 刷新失败', e)
          throw e
        })
        .finally(() => {
          this.refreshing = null
        })
    }
    await this.refreshing
    t = loadTokens()
    if (!t) throw new Error('未登录')
    return t.accessToken
  }

  /** 服务端拒绝（401）但本地认为未过期时使用：强制走一次刷新再返回新 token */
  async forceRefresh(): Promise<string> {
    const t = loadTokens()
    if (!t || !t.refreshToken) throw new Error('未登录')
    saveTokens({ ...t, expiresAt: 0 })
    return this.getAccessToken()
  }

  private async doRefresh(): Promise<void> {
    const s = loadSettings()
    const t = loadTokens()
    if (!t || !t.refreshToken) throw new Error('未登录')
    const refreshTokenAtStart = t.refreshToken
    const body = new URLSearchParams({
      client_id: s.clientId,
      client_secret: s.clientSecret,
      refresh_token: t.refreshToken,
      grant_type: 'refresh_token'
    })
    let res: { access_token: string; expires_in: number }
    try {
      res = await netClient.requestJson<{
        access_token: string
        expires_in: number
      }>('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      })
    } catch (e) {
      const msg = (e as Error).message || ''
      // token 端点返回 invalid_grant/invalid_token = 授权已被撤销或过期，标记需要重新登录
      if (msg.includes('invalid_grant') || msg.includes('invalid_token')) this.markInvalid()
      throw e
    }
    // 刷新期间可能已退出登录/重新登录：凭据不一致时放弃写入，避免旧会话复活
    const current = loadTokens()
    if (!current || current.refreshToken !== refreshTokenAtStart) return
    saveTokens({
      ...current,
      accessToken: res.access_token,
      expiresAt: Date.now() + res.expires_in * 1000
    })
    logger.info('token 已自动续期')
  }

  private markInvalid(): void {
    if (this.invalidGrant) return
    this.invalidGrant = true
    logger.error('refresh token 已失效，需要重新登录')
    this.broadcastAuth()
  }

  private async listenLoopback(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer()
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') resolve(addr.port)
        else reject(new Error('loopback 端口分配失败'))
      })
      // 保存到实例上供 waitLoopbackCode 复用
      this.loopbackServer = server
    })
  }

  private loopbackServer: http.Server | null = null
  private authWindow: BrowserWindow | null = null

  /**
   * 应用内独立登录窗口：
   * - 使用独立 session 分区（persist:googled-auth），与用户浏览器 / 其他配置文件完全隔离，
   *   多账号用户不会被默认浏览器的登录态带偏，窗口里自己选账号
   * - Google 回调到本地 127.0.0.1 时，成功页直接显示在本窗口里
   */
  private async openAuthWindow(url: string): Promise<void> {
    const ses = session.fromPartition('persist:googled-auth')
    const win = new BrowserWindow({
      width: 500,
      height: 760,
      title: '登录 Google 账号',
      autoHideMenuBar: true,
      webPreferences: {
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false
      }
    })
    this.authWindow = win
    win.on('closed', () => {
      this.authWindow = null
    })
    try {
      await win.loadURL(url)
    } catch (e) {
      logger.warn('内嵌登录窗口加载失败，改用系统浏览器', e)
      void shell.openExternal(url)
    }
  }

  private closeAuthWindow(delayMs = 1200): void {
    const win = this.authWindow
    if (!win) return
    setTimeout(() => {
      if (!win.isDestroyed()) win.close()
    }, delayMs)
  }

  private waitLoopbackCode(port: number, state: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = this.loopbackServer
      if (!server) return reject(new Error('loopback 服务未启动'))
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('授权超时（5 分钟未完成登录）'))
      }, 5 * 60 * 1000)
      const cleanup = () => {
        clearTimeout(timer)
        server.close()
        this.loopbackServer = null
      }
      server.once('request', (req, res) => {
        try {
          const u = new URL(req.url || '/', 'http://127.0.0.1')
          const err = u.searchParams.get('error')
          const code = u.searchParams.get('code')
          const gotState = u.searchParams.get('state')
          res.setHeader('content-type', 'text/html; charset=utf-8')
          if (err || !code || gotState !== state) {
            res.statusCode = 400
            res.end('<meta charset="utf-8"><h2>授权失败</h2>请返回 GOOGLEd 重试。')
            cleanup()
            reject(new Error(err || '回调参数错误'))
            return
          }
          res.statusCode = 200
          res.end('<meta charset="utf-8"><h2>✅ 授权成功</h2>可以关闭此页面，回到 GOOGLEd 继续使用。')
          this.closeAuthWindow()
          cleanup()
          resolve(code)
        } catch (e) {
          cleanup()
          reject(e as Error)
        }
      })
    })
  }

  private async exchangeCode(
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string
  ): Promise<Omit<StoredTokens, 'user'>> {
    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    })
    const r = await netClient.requestJson<{
      access_token: string
      refresh_token?: string
      expires_in: number
    }>('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    })
    if (!r.refresh_token) {
      throw new Error('Google 未返回 refresh_token，请在授权页面先移除本应用的访问权限后重试（prompt=consent 已强制要求）')
    }
    return {
      accessToken: r.access_token,
      refreshToken: r.refresh_token,
      expiresAt: Date.now() + r.expires_in * 1000
    }
  }

  private async fetchUser(accessToken: string): Promise<AuthUserInfo> {
    try {
      return await netClient.requestJson<AuthUserInfo>('https://oauth2.googleapis.com/oauth2/v3/userinfo', {
        headers: { authorization: `Bearer ${accessToken}` }
      })
    } catch {
      return {}
    }
  }
}

export const authService = new AuthService()
