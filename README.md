# GOOGLEd 云盘

[![Build Windows](https://github.com/conm599/GOOGLEd/actions/workflows/build.yml/badge.svg)](https://github.com/conm599/GOOGLEd/actions/workflows/build.yml)

面向中国用户的 Google 云盘桌面客户端。核心卖点：**上传/下载断点续传**、**Cloudflare Workers 反代加速**（低成本稳定直连）、标准 OAuth2 自动续期登录。

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

- **GitHub Actions 自动打包（推荐）**： push 到 main 或手动触发 [Build Windows](https://github.com/conm599/GOOGLEd/actions/workflows/build.yml) 工作流，在 Artifacts 下载安装包；打 `v*` tag 会自动发布到 Releases
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
src/
├── shared/types.ts        # 主/渲染进程共享类型
├── main/                  # 主进程
│   ├── net/NetClient.ts   # 统一网络出口（直连/代理/Workers 反改写）
│   ├── net/workerTemplate.ts # CF Worker 部署代码模板
│   ├── auth/AuthService.ts   # OAuth2 loopback + 自动续期
│   ├── drive/DriveClient.ts  # Drive API v3 封装
│   ├── transfer/             # 断点续传引擎
│   │   ├── TransferEngine.ts # 队列/并发/调度
│   │   ├── UploadTask.ts     # Resumable Upload 协议
│   │   ├── DownloadTask.ts   # Range 断点下载
│   │   └── taskStore.ts      # 断点持久化
│   ├── settings.ts        # 设置 + token 加密存储
│   └── ipc.ts             # IPC 通道注册
├── preload/index.ts       # contextBridge
└── renderer/src/          # Vue 3 + Element Plus 界面
    ├── views/FilesView / TransfersView / SharesView / SettingsView
    └── components/WelcomeGate（首启向导）/ ShareDialog
```

