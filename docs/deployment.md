# Web 服务器与部署

**简体中文** | [English](./deployment.en.md) · [← 返回 README](../README.md)

在无 GUI 的服务器上运行 `session-web`，通过浏览器访问；以及 Docker、安全与多机节点。

## Web 服务器

适合无 GUI 的服务器环境，通过浏览器远程访问。二进制为 musl 静态编译，**零系统依赖**，任何 Linux 发行版（Ubuntu、Debian、Rocky、CentOS、Alpine 等）下载即可运行。

**直接运行（推荐）：**

```bash
# 最简启动（默认只监听 127.0.0.1:3000，仅本机可访问）
./session-web

# 局域网/公网访问：监听所有网卡时必须设置 --token，否则拒绝启动
./session-web --host 0.0.0.0 --port 8080 --token my-secret

# 环境变量
ASV_HOST=0.0.0.0 ASV_PORT=8080 ASV_TOKEN=my-secret ./session-web
```

| 参数 | 环境变量 | 默认值 | 说明 |
|------|---------|--------|------|
| `--host` | `ASV_HOST` | `127.0.0.1` | 监听地址（`127.0.0.1` = 仅本机，`0.0.0.0` = 所有网卡） |
| `--port` | `ASV_PORT` | `3000` | 监听端口 |
| `--token` | `ASV_TOKEN` | *(无)* | Bearer Token 认证；监听非本机地址时**必须设置** |
| `--allow-no-auth` | `ASV_ALLOW_NO_AUTH` | 关闭 | 允许非本机地址免认证启动（不安全，仅限可信内网） |
| `--allowed-origins` | `ASV_ALLOWED_ORIGINS` | *(无)* | 额外允许跨域访问 / 建立 WebSocket 的来源，逗号分隔（如反向代理域名） |
| `--allow-skip-permissions` | `ASV_ALLOW_SKIP_PERMISSIONS` | 关闭 | 允许续聊客户端请求跳过权限（`--dangerously-skip-permissions`） |
| `--allow-client-credentials` | `ASV_ALLOW_CLIENT_CREDENTIALS` | 关闭 | 允许续聊客户端传入自定义 API Key / Base URL |

**直接运行 vs Docker：**

|  | 直接运行二进制（推荐） | Docker |
|---|---|---|
| CLI 对话 / Resume | ✅ 完整支持（直接调用宿主机 CLI） | ❌ 容器隔离，无法访问宿主机 CLI |
| 系统依赖 | 无（musl 静态编译） | 需要 Docker |
| 部署方式 | 下载 → `chmod +x` → 运行 | `docker compose up` |
| 适用场景 | **个人服务器、需要对话功能** | **团队共享、只浏览历史记录** |

**Docker 运行：**

```bash
docker compose up        # 前台
docker compose up -d     # 后台
```

挂载路径、端口等在 [`docker-compose.yml`](../docker-compose.yml) 配置。容器监听 `0.0.0.0`，因此**必须设置令牌**：

```bash
ASV_TOKEN=my-secret docker compose up -d
```

> ⚠️ **安全警告**
>
> 应用会读取服务器上的 `~/.claude/projects/`、`~/.codex/sessions/` 和 `~/.grok/sessions/`，包含**完整会话记录（可能含 API Key、代码、隐私对话）**。务必按部署场景采取措施：
>
> | 场景 | 建议措施 |
> |------|---------|
> | **仅本机使用** | 默认即 `127.0.0.1`，仅 localhost 可达 |
> | **局域网共享** | 设置 `ASV_TOKEN`，防火墙限制端口仅内网可达 |
> | **公网暴露** | 设置 `ASV_TOKEN` + 前置 Nginx/Caddy 反向代理 + 启用 HTTPS/TLS |
>
> 应用本身**不提供 HTTPS**，明文 HTTP 下 Token 亦明文传输，生产环境务必在反向代理层终止 TLS。

## Web 版与桌面版的差异

| 功能 | 桌面应用 | Web 服务器 |
|------|---------|-----------|
| 恢复会话 | 打开系统终端 | 复制命令到剪贴板 |
| 删除会话 | 移入回收站 | 移入回收站 |
| 会话分叉 | 四来源创建新会话 + 终端打开 | 四来源创建新会话 + 跳转浏览/续聊 |
| CLI 对话 | 本地 spawn CLI 进程 | WebSocket 转发 |
| 自动更新 | 应用内更新 | 不适用 |
| 文件监听 | Tauri 事件 | WebSocket 推送 |
| 认证 | 不需要 | 仅本机监听时可选；非本机监听必须设置 Bearer Token |

## 多机节点

侧边栏顶部可注册多个 `session-web` 地址、保存各节点独立的 Bearer Token，并显示当前节点连接状态。切换机器后，项目、会话、搜索、统计、文件监听和 CLI 对话会统一访问所选节点；桌面端的“本机”节点仍使用 Tauri IPC。

- 远程节点必须填写 `http://` 或 `https://` 根地址，不接受 URL 内嵌账号密码
- 桌面端连接远程节点时，文件夹选择和终端恢复按 Web 模式处理，避免误操作本机路径
- 节点配置仅保存在当前客户端的 `localStorage`，不会上传到服务器
- 多机统计当前按所选节点独立展示，不会静默合并
- Skill、MCP 和插件安装声明同步的安全边界见 [`MULTI_NODE_SYNC_DESIGN.md`](../MULTI_NODE_SYNC_DESIGN.md)
