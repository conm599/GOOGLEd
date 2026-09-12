// Cloudflare Workers 反代模板 —— 作为文本提供给用户复制部署（不参与运行）。
// 用法：https://你的域名/https://目标地址
// 详细部署步骤见 docs/worker-deploy.md，或在应用「设置 → 网络」折叠面板中一键复制。

export const workerTemplate = `const ALLOWED_HOSTS = [
  'www.googleapis.com',
  'oauth2.googleapis.com',
  'accounts.google.com',
  'drive.google.com',
  'lh3.googleusercontent.com'
]

export default {
  async fetch(request) {
    const url = new URL(request.url)
    let target = decodeURIComponent(url.pathname.slice(1))
    if (!target) {
      return new Response('GOOGLEd Workers 反代运行中。\\n用法: https://<host>/<完整目标URL>', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' }
      })
    }
    if (!target.startsWith('https://')) target = 'https://' + target
    let targetUrl
    try {
      targetUrl = new URL(target + url.search)
    } catch {
      return new Response('bad target', { status: 400 })
    }
    if (!ALLOWED_HOSTS.includes(targetUrl.host)) {
      return new Response('host not allowed: ' + targetUrl.host, { status: 403 })
    }
    const headers = new Headers(request.headers)
    headers.delete('host')
    headers.delete('cf-connecting-ip')
    headers.delete('cf-ipcountry')
    headers.delete('cf-ray')
    headers.delete('cf-visitor')
    headers.delete('x-forwarded-proto')
    headers.delete('accept-encoding')
    const upstream = await fetch(targetUrl.toString(), {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
      duplex: 'half'
    })
    const respHeaders = new Headers(upstream.headers)
    respHeaders.delete('content-security-policy')
    respHeaders.delete('x-frame-options')
    respHeaders.set('x-gd-proxy', targetUrl.host)
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: respHeaders
    })
  }
}
`
