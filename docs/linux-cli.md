# GOOGLEd Linux CLI

复用 Windows 版的传输引擎（断点续传 / Workers 反代 / 增量备份），以纯 Node 命令行形态提供全部功能，不含 GUI。

## 安装

```bash
# 从 GitHub Releases 下载（需要 Node.js ≥ 20）
tar -xzf googled-linux-x64.tar.gz
sudo mv googled/googled /usr/local/bin/googled && sudo chmod +x /usr/local/bin/googled
googled help
```

数据目录：`~/.config/googled`（可用 `GOOGLED_HOME` 覆盖）。

## 5 分钟上手

```bash
# 1. 配置 OAuth 凭据（与 Windows 版共用同一套 GCP 凭据，见 docs/gcp-setup.md）
googled config import-client ~/下载/client_secret_xxx.json

# 2. （中国大陆服务器推荐）配置 Cloudflare Workers 反代
googled config set netMode workers
googled config set workerBase https://你的.workers.dev
googled config test-worker

# 3. 登录（打印链接，浏览器授权回调到本机 127.0.0.1）
googled login

# 4. 使用
googled ls
googled upload ./电影 -t media          # 断点续传，默认等完
googled download media/xxx.mkv -d ~/下载
googled quota
```

> SSH 无浏览器环境：`googled login` 会给出端口转发提示，
> 先 `ssh -L <端口>:127.0.0.1:<端口> user@host` 再在本机浏览器打开链接。

## 常用命令

| 命令 | 说明 |
|---|---|
| `googled status` | 登录/网络/队列/备份概览 |
| `googled ls [-l] [路径]` | 列目录（支持 `id:文件id`、`root`） |
| `googled upload <本地...> -t <远程文件夹>` | 上传（断点续传；`--no-wait` 落盘后台跑） |
| `googled download <远程...> -d <目录>` | 下载（支持整个文件夹递归） |
| `googled cat <远程文件>` | 打印 ≤2MB 文本文件 |
| `googled rm <远程...> [--hard]` | 移入回收站 / 彻底删除 |
| `googled mv / cp / rename / mkdir / search` | 文件管理 |
| `googled share <路径> [--role writer]` | 创建 anyone 链接；`--revoke` 取消 |
| `googled trash list/restore/empty` | 回收站 |
| `googled transfer list/pause/resume/cancel` | 传输队列（含断点任务） |
| `googled sync` | 恢复队列全部任务并等待完成 |
| `googled backup add/list/remove/sync/watch` | 增量备份（同 Windows 版逻辑） |
| `googled daemon` | 常驻：备份监控 + 定时任务 + 传输队列 + 缓存清理 |
| `googled update check/install` | 自更新（多通道 + 断点续传） |

## 服务器常驻（备份/定时任务）

```bash
googled install-service
systemctl --user daemon-reload
systemctl --user enable --now googled
journalctl --user -u googled -f

# 无桌面的服务器执行一次（否则退出 SSH 后 user service 停止）
loginctl enable-linger $USER
```

## 网络

- `direct`：直连
- `system`：读 `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` 环境变量（支持 `http://` 与 `socks5://`）
- `proxy`：自定义代理，`googled config set proxyProtocol socks5` + `proxyHost/proxyPort`
- `workers`：Cloudflare Workers 反代（与 Windows 版同一套多域名容灾/冷却逻辑）

## 凭据安全

- refresh token 用 AES-256-GCM 加密存储；默认密钥文件 `~/.config/googled/token.key`（0600）
- 设置 `GOOGLED_TOKEN_PASSPHRASE` 后改用口令派生密钥（scrypt），密钥不落盘，跨机器迁移需同口令

## 更新

`googled update install` 从 GitHub Releases 下载 `googled-linux-x64.tar.gz`（支持代理多通道 + 断点续传），
解压后原子替换自身二进制，下次启动生效。
