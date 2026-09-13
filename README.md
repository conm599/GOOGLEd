# GOOGLEd 云盘

[![Build](https://github.com/conm599/GOOGLEd/actions/workflows/build.yml/badge.svg)](https://github.com/conm599/GOOGLEd/actions/workflows/build.yml)

面向中国用户的 Google 云盘客户端（**Windows GUI + Linux CLI**）。核心卖点：**上传/下载断点续传**、**Cloudflare Workers 反代加速**（低成本稳定直连）、标准 OAuth2 自动续期登录。

> 本分支（linux-port）为双平台结构：
> - `packages/core` —— 纯 Node 共享引擎（传输/断点续传/备份/Drive API/OAuth/网络出口），两平台共用同一份代码
> - 根目录 `src/main` —— Windows Electron GUI（行为与此前版本一致，平台能力经 `platform-electron.ts` 注入）
> - `packages/linux` —— Linux CLI（Node 适配器 + 全功能命令行，见 [docs/linux-cli.md](docs/linux-cli.md)）
> - CI 每次构建同时发布 Windows 安装包与 Linux CLI 压缩包到同一 Release，版本号一致；**Windows 应用内更新链路不变**

## 功能

- **断点续传传输引擎**（核心）
  - 上传走 Google 官方 Resumable Upload 协议：分块 PUT、会话落盘、崩溃/重启后自动查询服务器进度续传
  - 下载走 HTTP Range 断点下载：`.part` 临时文件 + ETag 校验 + MD5 完整性验证
  - 多任务队列、并发控制、失败自动重试（指数退避）、暂停/继续
- **文件管理**：浏览/面包屑导航/搜索/排序/新建文件夹/重命名/删除、缩略图网格视图
- **回收站**：全量加载（不分页截断）、批量彻底删除、一键清空回收站（自动循环核对到删净）
- **传输体验**：每个任务实时速度显示；上传分块遇到慢线路自动减小（对 CF 反代 ~100s 上游超时的自适应）
- **Workers 多域名容灾**：反代地址可填多个域名，某个域名挂起/持续报错时自动切换，恢复后自动切回
- **托盘常驻**：关闭窗口最小化到托盘；支持**开机自启动**与**静默自启动**（不弹窗直接进托盘后台运行）
- **文件夹增量备份**：绑定本地文件夹 → 云端自动建目录，增量对比上传；自动监控变更（去抖）、定时备份、录屏类边写边传文件的稳定检测；断点信息持久化，重启可恢复
- **分享链接**：创建/复制/取消 anyone 链接、查看权限列表
- **网络模式**（为中国网络环境设计）
  - 直连 / 系统代理 / 自定义 HTTP·SOCKS5 代理
  - **Cloudflare Workers 反代**：`https://你的域名/https://目标地址` 格式，免费稳定，应用内一键测试连通性 + 一键复制部署代码
- **登录**：标准 OAuth2 loopback 流程，refresh token 加密存储（Windows DPAPI），长期自动续期，无需重复登录；支持一键**退出登录**（撤销 Google 服务端授权 + 清空登录窗口会话）与**重新登录**（重授权/换号），授权失效时自动检测并引导重新登录

## 快速开始（开发）

```bash
npm install     # 已配置 npmmirror 镜像加速
npm run dev     # 启动开发版
```

## 获取安装包

- **GitHub Actions 自动打包（推荐）**：push 到 main 或手动触发 [Build Windows](https://github.com/conm599/GOOGLEd/actions/workflows/build.yml) 工作流——**每次打包版本号自动 +1 并自动发布到 [Releases](https://github.com/conm599/GOOGLEd/releases)**（含安装包），无需手动操作；打 `v*` tag 则发指定版本
- 本地打包：

```bash
npm run dist:win   # 输出到 release/<version>/GOOGLEd Setup x.x.x.exe
```

## 首次使用（5 分钟配置）

1. **申请 OAuth 凭据**：见 [docs/gcp-setup.md](docs/gcp-setup.md) —— 需要你自己的 Google Cloud 项目（免费）
2. **配置网络**：见 [docs/worker-deploy.md](docs/worker-deploy.md) —— 部署你自己的 Cloudflare Workers 反代（免费额度足够个人使用）
3. 应用内「设置 → 账号」登录，开始使用

## 目录结构

```
packages/core/src/       # 共享引擎（纯 Node，零 electron 依赖）
├── platform.ts          # 平台抽象：宿主注入路径/加密/网络/UI 能力
├── net/NetClient.ts     # 统一网络出口（直连/代理/Workers 反改写）
├── auth/AuthService.ts  # OAuth2 loopback + 自动续期
├── drive/DriveClient.ts # Drive API v3 封装
├── transfer/            # 断点续传引擎（队列/Resumable Upload/Range 下载/断点持久化）
├── backup/              # 文件夹增量备份
└── storage/DiskCache.ts # 缓存统计与清理
src/main/                # Windows GUI 主进程（Electron 壳 + platform-electron 适配器）
packages/linux/src/      # Linux CLI（platform-node 适配器 + 命令实现）
src/preload、src/renderer # preload 与 Vue 3 + Element Plus 界面
```

