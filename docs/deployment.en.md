# Web server and deployment

[简体中文](./deployment.md) | **English** · [← Back to README](../README.en.md)

Run `session-web` on a headless server and use it from a browser; plus Docker, security, and multiple machines.

## Web server

The Linux web server is a static musl executable. It runs without WebKit or other desktop GUI dependencies.

```bash
chmod +x ./session-web

# Default: loopback only (127.0.0.1:3000)
./session-web

# Network access: a token is required when binding to a non-loopback address
./session-web --host 0.0.0.0 --port 8080 --token my-secret

# Equivalent environment variables
ASV_HOST=0.0.0.0 ASV_PORT=8080 ASV_TOKEN=my-secret ./session-web
```

| Option | Environment variable | Default |
|---|---|---|
| `--host` | `ASV_HOST` | `127.0.0.1` |
| `--port` | `ASV_PORT` | `3000` |
| `--token` | `ASV_TOKEN` | None; required for non-loopback hosts |
| `--allow-no-auth` | `ASV_ALLOW_NO_AUTH` | Off; allow a non-loopback host without a token (unsafe) |
| `--allowed-origins` | `ASV_ALLOWED_ORIGINS` | None; extra comma-separated origins allowed for CORS / WebSockets |
| `--allow-skip-permissions` | `ASV_ALLOW_SKIP_PERMISSIONS` | Off; let chat clients request `--dangerously-skip-permissions` |
| `--allow-client-credentials` | `ASV_ALLOW_CLIENT_CREDENTIALS` | Off; let chat clients supply their own API key / base URL |

## Docker

```bash
docker compose up -d
```

Configure mounts and ports in [docker-compose.yml](../docker-compose.yml). The container binds `0.0.0.0`, so a token is **required**: `ASV_TOKEN=my-secret docker compose up -d`.

| | Native web executable | Docker |
|---|---|---|
| Browse, search, statistics | Supported | Supported |
| Host CLI conversations | Calls the installed host CLI | Host CLIs are inaccessible due to container isolation |
| Runtime requirement | Static Linux executable | Docker |
| Typical use | Personal server with CLI access | Shared history browser |

**Access protection:** session histories may contain source code, credentials, and private conversations. Local use needs nothing extra — the default bind is `127.0.0.1`. For LAN access, configure a token and restrict the port with a firewall. For public access, also use an HTTPS reverse proxy such as Nginx or Caddy. The server itself does not provide HTTPS; tokens sent over plain HTTP are not encrypted.

## Desktop and web differences

| Feature | Desktop | Web |
|---|---|---|
| Resume | Open a system terminal | Copy a resume command |
| Delete session | Move to recycle bin | Move to recycle bin |
| Fork | Create a session and open its terminal | Create and navigate to the new session |
| In-app chat | Local CLI process | Server CLI through WebSocket |
| Updates | In-app updater / release link | Manual deployment |
| File changes | Tauri events | WebSocket events |
| Authentication | None for local IPC | Optional on loopback; bearer token required for network binds |

## Multiple machines

Register `session-web` root URLs in the sidebar's machine selector. Each node has its own token and connection status. Browsing, search, statistics, file watching, and chat use the selected node. The desktop's local node continues to use Tauri IPC.

- Use an `http://` or `https://` root URL without embedded credentials.
- Remote folder selection and resume behavior follow web mode, even from the desktop app.
- Node preferences stay in the current client's localStorage.
- Statistics are displayed per node rather than merged.
- See [MULTI_NODE_SYNC_DESIGN.md](../MULTI_NODE_SYNC_DESIGN.md) for synchronization boundaries.
