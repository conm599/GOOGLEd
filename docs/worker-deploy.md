# 部署 Cloudflare Workers 反代（约 3 分钟，免费）

原理：GOOGLEd 把对 Google 的请求改写为 `https://你的worker地址/https://目标URL`，由 Cloudflare 边缘节点中转，绕开直连不通的网络环境。免费版每天 10 万次请求，个人使用绰绰有余。

## 部署步骤

1. 注册/登录 Cloudflare：https://dash.cloudflare.com/sign-up

2. 左侧菜单「**Workers 和 Pages**」→「**创建应用程序**」→「**创建 Worker**」
   - 名称随意（如 `gd-proxy`），点「部署」

3. 部署成功后点「**编辑代码**」，把编辑器里的内容**全部删除**，粘贴下面的完整代码，再点右上角「**部署**」：

```javascript
const ALLOWED_HOSTS = [
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
      return new Response('GOOGLEd Workers 反代运行中。\n用法: https://<host>/<完整目标URL>', {
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
```

4. 在 GOOGLEd「设置 → 网络」选「Workers 反代」，填入你的地址（形如 `https://gd-proxy.你的子域名.workers.dev`），点「**测试连通性**」。

> 应用内「设置 → 网络」的折叠面板里也有一键复制完整代码的按钮。

## 安全建议

- Worker 代码里的 `ALLOWED_HOSTS` 只放行 Google 域名，避免你的 Worker 被他人当公共代理滥用
- 如果不想暴露在 `workers.dev` 域名下，可以在 Worker 设置里绑定自己的自定义域名
- 免费版限额：10 万请求/天。大文件分块传输会产生较多请求（16MB 分块 ≈ 1GB/65 请求），如不够可把分块调大（设置 → 传输）
