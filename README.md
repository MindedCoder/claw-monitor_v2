# Claw Monitor v2

独立监控面板 & 部署工具，与 OpenClaw 完全解耦，不依赖任何 Skill 机制。

## 架构

```
┌─────────────────────────────────────────────────────────┐
│                    macOS LaunchAgent                     │
│              (开机自启 + KeepAlive 保活)                  │
├─────────────────────────────────────────────────────────┤
│                  nohup + while-loop                      │
│                (进程退出 3s 自动重启)                      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│   Node.js HTTP Server (:9001)                           │
│   ┌───────────────────────────────────────────────┐     │
│   │  Dashboard 面板                                │     │
│   │  ├── Ping 探测 (百度 / Google)                  │     │
│   │  ├── Codex 使用量                              │     │
│   │  ├── OpenClaw 健康检查                          │     │
│   │  ├── 日志收集器 (SSE 实时流)                    │     │
│   │  ├── 系统日志                                  │     │
│   │  └── 静态部署记录                              │     │
│   └───────────────────────────────────────────────┘     │
│                                                         │
│   ┌──────────────┐  ┌──────────────────────────┐       │
│   │  frpc 隧道    │  │  Auth Gateway (:4180)    │       │
│   │  (内置保活    │  │  密码 / 飞书 / 微信       │       │
│   │   指数退避)   │  │  Telegram / 多租户        │       │
│   └──────────────┘  └──────────────────────────┘       │
│                                                         │
├─────────────────────────────────────────────────────────┤
│   POST /api/deploy         静态网页部署                  │
│   GET  /static/*           部署产物访问                  │
└─────────────────────────────────────────────────────────┘
```

### 三层保活

| 层级 | 机制 | 作用 |
|------|------|------|
| 1 | macOS LaunchAgent (`KeepAlive`) | 开机/登录自启，崩溃 5s 后 launchd 拉起 |
| 2 | nohup + while-loop | 手动启动时的兜底保活，3s 重启 |
| 3 | Node 内部 frpc 管理 | frpc 挂了指数退避重启 (3s~30s) |

## 目录结构

```
claw-monitor_v2/
├── install.sh              # 安装脚本
├── update.sh               # 更新脚本
├── uninstall.sh            # 卸载脚本
├── config.example.json     # 配置模板
├── package.json
│
├── src/
│   ├── index.js            # 入口：启动所有模块
│   ├── server.js           # HTTP 路由分发
│   ├── config.js           # 配置加载
│   ├── panels/
│   │   ├── ping.js         # 百度/Google Ping 面板
│   │   ├── codex-usage.js  # Codex 使用量面板
│   │   ├── health.js       # OpenClaw 健康检查面板
│   │   ├── logs.js         # 通用日志收集器
│   │   └── system-log.js   # 系统自由日志
│   ├── deploy/
│   │   └── static-deploy.js  # 静态网页部署 API
│   ├── dashboard/
│   │   ├── renderer.js     # 面板组装
│   │   ├── layout.js       # 页面框架 + CSS/JS
│   │   └── components.js   # HTML 组件
│   └── lib/
│       ├── ring-buffer.js  # 环形缓冲区
│       ├── fetch-utils.js  # 带超时的 fetch
│       ├── http-helpers.js # HTTP 响应工具
│       ├── html.js         # HTML 转义 + 时间格式化
│       └── process-manager.js  # 子进程管理
│
├── services/
│   ├── frpc/
│   │   ├── manager.js      # frpc 下载/安装/启停/保活
│   │   └── templates.js    # TOML 配置生成
│   └── auth-gateway/
│       ├── gateway.js      # 认证网关主服务
│       ├── session.js      # 内存会话管理
│       ├── tenant.js       # 多租户路由
│       └── providers/      # 认证提供者
│           ├── password.js
│           ├── feishu.js
│           ├── wechat.js
│           └── telegram.js
│
└── data/                   # 运行时数据 (gitignore)
    ├── config.json         # 用户配置
    ├── monitor.log         # 服务日志
    ├── frpc.toml           # 生成的 frpc 配置
    └── static/             # 部署的静态文件
```

## 安装

```bash
git clone https://github.com/MindedCoder/claw-monitor_v2.git ~/bfe/claw-monitor_v2 && bash ~/bfe/claw-monitor_v2/install.sh
```

安装脚本自动完成：
- 检测 Node.js (>= 18)
- 生成默认配置 `data/config.json`
- 下载安装 frpc
- 启动监控服务 (带保活)
- 注册 macOS LaunchAgent (开机自启)

安装完成后访问: http://127.0.0.1:9001

## 配置

编辑 `data/config.json`，主要配置项：

```jsonc
{
  "port": 9001,                    // 监控面板端口
  "instanceName": "my-server",     // 实例名称

  "health": {
    "enabled": true,
    "url": "http://127.0.0.1:18789/health",  // OpenClaw 健康检查地址
    "intervalMs": 5000
  },

  "ping": {
    "enabled": true,
    "targets": [                   // Ping 目标列表
      { "name": "Google", "url": "https://www.google.com" },
      { "name": "Baidu", "url": "https://www.baidu.com" }
    ]
  },

  "codexUsage": {
    "enabled": true,
    "authProfilesPath": "~/.openclaw/agents/main/agent/auth-profiles.json"
  },

  "logs": {
    "sources": [                   // 自定义日志源
      { "name": "gateway", "path": "~/.openclaw/logs/gateway.log" },
      { "name": "errors", "path": "~/.openclaw/logs/gateway.err.log" }
    ]
  },

  "frpc": {
    "serverAddr": "1.2.3.4",       // 配置后自动启动 frpc
    "serverPort": 7000,
    "proxies": [
      { "name": "monitor", "type": "http", "localPort": 9001, "customDomains": ["claw.example.com"] }
    ]
  },

  "authGateway": {
    "port": 4180,                  // 认证网关，配置即启动
    "authProvider": "password",
    "provider": { "password": "changeme" }
  }
}
```

修改配置后重新运行 `bash install.sh` 生效。

## API

### 监控面板

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/` | 监控面板页面 |
| GET | `/api/status` | 全量状态 JSON |
| GET | `/api/html` | 面板 HTML 片段 (自动刷新用) |
| GET | `/healthz` | 服务健康检查 |

### Ping 探测

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/ping` | 获取最新 Ping 状态 |
| GET | `/api/ping/trigger` | 立即 Ping 所有目标 |
| GET | `/api/ping/trigger/one?name=Google` | Ping 单个目标 |
| GET | `/api/ping/history?name=Google` | 获取历史记录 |

### Codex 使用量

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/codex-usage` | 获取缓存的使用量数据 |
| GET | `/api/codex-usage/refresh` | 立即刷新使用量 |

### OpenClaw 健康检查

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/health` | 获取健康状态 |
| GET | `/api/health/check` | 立即执行健康检查 |
| GET | `/api/health/history` | 检查历史记录 |

### 日志

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/logs` | 获取收集的日志 |
| GET | `/api/logs/stream` | SSE 实时日志流 |
| GET | `/api/system-log` | 获取系统日志 |
| POST | `/api/system-log` | 写入系统日志 `{ "level": "info", "msg": "..." }` |

### 静态部署

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/deploy` | 部署静态页面 |
| GET | `/api/deploy/history` | 部署历史 |
| GET | `/static/*` | 访问已部署的静态文件 |

部署请求示例：

```bash
curl -X POST http://127.0.0.1:9001/api/deploy \
  -H "Content-Type: application/json" \
  -d '{"htmlPath": "/abs/path/to/page.html", "platform": "youzan", "resources": ["images", "css"]}'
```

返回：

```json
{ "url": "/static/20260330/youzan/143052.html", "instanceName": "my-server" }
```

### frpc 管理

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/frpc/status` | frpc 状态 (含保活/重启次数) |
| POST | `/api/frpc/start` | 启动 frpc (默认开启保活) |
| POST | `/api/frpc/stop` | 停止 frpc (关闭保活) |
| POST | `/api/frpc/install` | 下载安装 frpc 二进制 |

## 更新

```bash
cd ~/bfe/claw-monitor_v2 && git pull && bash update.sh
```

自动停止旧进程、更新源码、保留 `data/config.json`、重启服务。

## 卸载

```bash
bash ~/bfe/claw-monitor_v2/uninstall.sh
```

卸载脚本会交互式询问是否清理：
- LaunchAgent (自动移除，无需确认)
- frpc 二进制
- data 目录 (配置、日志、静态文件)
- 项目目录

## 技术栈

- Node.js >= 18 (原生 HTTP，零依赖)
- ES Modules
- macOS LaunchAgent (开机自启)
- frpc 0.61.1 (内网穿透)
