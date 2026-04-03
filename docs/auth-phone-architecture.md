# Claw Monitor v2 — 系统架构与设计文档

## 一、全局架构总览

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                             用户浏览器                                        │
│                                                                              │
│  访问 claw.bfelab.com/huangcan/dashboard                                     │
│  访问 claw.bfelab.com/xiehu/dashboard                                        │
└──────────────────────┬───────────────────────────────────────────────────────┘
                       │
                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                        Nginx Ingress (K8s)                                    │
│                                                                              │
│  规则1: /auth/*                    ──→ auth-gateway:4180  (无需认证)          │
│  规则2: /{tenant}/api/*            ──→ frps:19090         (无需认证)          │
│         /{tenant}/static/*         ──→ frps:19090         (无需认证)          │
│         /{tenant}/healthz          ──→ frps:19090         (无需认证)          │
│  规则3: /*                         ──→ frps:19090         (需 auth_request)   │
│         ├─ auth-url:    http://auth-gateway:4180/auth/check                  │
│         └─ auth-signin: https://claw.bfelab.com/auth/login?rd=$uri           │
└──────────┬──────────────────────────────┬────────────────────────────────────┘
           │                              │
           ▼                              ▼
┌─────────────────────┐    ┌─────────────────────────────────────────────┐
│  auth-gateway:4180  │    │              frps (FRP Server)              │
│                     │    │                                             │
│  认证 + 会话管理     │    │  bindPort:  7000  (frpc 客户端连接)         │
│  租户路由           │    │  vhostHTTP: 19090 (HTTP 反向代理)           │
│  手机验证码         │    │                                             │
│  OAuth (飞书等)     │    │  虚拟主机路由:                               │
└────────┬────────────┘    │  /huangcan/* ──→ frpc-huangcan ──→ :9001   │
         │                 │  /xiehu/*    ──→ frpc-xiehu    ──→ :9001   │
         ▼                 └───────────────────┬─────────────────────────┘
┌─────────────────────┐                        │ FRP 隧道 (TCP/7000)
│      MongoDB        │                        │
│                     │         ┌───────────────┴───────────────┐
│  users   集合       │         │                               │
│  sessions 集合      │         ▼                               ▼
│  codes   集合       │  ┌─────────────────┐          ┌─────────────────┐
└─────────────────────┘  │ 黄灿的本地机器    │          │ 谢虎的本地机器    │
                         │                 │          │                 │
┌─────────────────────┐  │  frpc ←隧道→ frps│          │  frpc ←隧道→ frps│
│   阿里云短信 API     │  │       │         │          │       │         │
│                     │  │       ▼         │          │       ▼         │
│  发送验证码到手机    │  │  claw-monitor   │          │  claw-monitor   │
└─────────────────────┘  │  :9001          │          │  :9001          │
                         │  ├─ 监控面板     │          │  ├─ 监控面板     │
                         │  ├─ API 接口     │          │  ├─ API 接口     │
                         │  ├─ 日志流       │          │  ├─ 日志流       │
                         │  └─ 静态部署     │          │  └─ 静态部署     │
                         └─────────────────┘          └─────────────────┘
```

---

## 二、各组件详细设计

### 2.1 Claw Monitor 主服务 (本地 :9001)

每台本地机器上独立运行的 Node.js 监控服务，**零外部依赖**。

```
src/
├── index.js              # 入口：启动所有模块，注册路由，开始轮询
├── server.js             # HTTP 服务器：路由分发 + 静态文件 + CORS
├── config.js             # 配置加载 + 热更新（每3秒检测 data/config.json）
│
├── dashboard/
│   ├── renderer.js       # 面板组装：收集各 panel.render() 拼接 HTML
│   ├── layout.js         # 页面外壳：HTML/CSS/JS 模板（暗色主题）
│   └── components.js     # HTML 组件工具函数
│
├── panels/               # 插件式面板（每个面板独立模块）
│   ├── health.js         # OpenClaw 健康检测
│   ├── ping.js           # 网络连通性测试
│   ├── codex-usage.js    # Codex API 用量追踪
│   ├── openclaw-status.js # OpenClaw 实时状态
│   ├── logs.js           # 日志文件尾随 + SSE 推流
│   ├── system-log.js     # 系统内部日志
│   └── deploy.js         # 静态文件部署记录
│
├── deploy/
│   └── static-deploy.js  # 部署 API：复制 HTML + 资源到 static 目录
│
└── lib/
    ├── ring-buffer.js    # 定长环形缓冲区（限制内存使用）
    ├── fetch-utils.js    # HTTP 请求 + 超时控制
    ├── http-helpers.js   # 响应工具（sendJson, sendHtml, send404）
    ├── html.js           # HTML 转义 + 时间格式化（北京时间）
    └── process-manager.js # 子进程管理
```

#### 启动流程

```
node src/index.js
    │
    ├─ ① loadConfig()                    加载 data/config.json
    ├─ ② 初始化 8 个 panel 模块实例
    ├─ ③ 收集所有 panel.routes()          合并路由表
    ├─ ④ createServer(routes)             启动 HTTP :9001
    ├─ ⑤ panel.startPolling()            启动有轮询需求的面板
    ├─ ⑥ frpc.start()                    启动 FRP 隧道（如配置）
    ├─ ⑦ startGateway()                  启动 auth-gateway（如配置）
    └─ ⑧ 注册 SIGTERM/SIGINT 优雅退出
```

#### 面板插件接口

每个面板导出一个工厂函数，返回统一结构：

```javascript
{
  name: 'panel-name',
  render():    string,       // 返回 HTML 片段
  routes():    object,       // 返回 { 'GET /api/xxx': handler }
  startPolling?(): void,     // 开始轮询（可选）
  stopPolling?():  void,     // 停止轮询（可选）
  getStatus?():    object,   // 返回当前状态（可选）
}
```

#### 面板功能说明

| 面板 | 数据来源 | 轮询间隔 | 缓冲区大小 | 说明 |
|------|----------|----------|-----------|------|
| health | HEAD 请求 OpenClaw `/health` | 5s | 100 条 | 连续失败 ≥3 次判定宕机 |
| ping | HEAD 请求外部 URL (Google/Baidu) | 手动触发 | 200 条 | 网络连通性 |
| codex-usage | Codex API `/wham/usage` | 5 min | 无 | 读取本地 auth-profiles.json 获取 token |
| openclaw-status | OpenClaw 健康端点 | 5s | 无 | 识别 thinking/answering/idle/offline |
| logs | 本地日志文件尾随 | 2s | 500 条 | SSE 实时推流到浏览器 |
| system-log | 内部事件记录 | 无 | 300 条 | SSE 推流 |
| deploy | 静态文件部署记录 | 无 | 无 | POST /api/deploy 触发 |

#### 前端刷新机制

```
浏览器加载完整 HTML 页面（首次 GET /）
    │
    └─ 内嵌 JS：每 3 秒 fetch('/api/html')
           │
           └─ 服务端调用 renderInner(panels) 只返回面板 HTML
                  │
                  └─ 浏览器替换 .app 容器的 innerHTML
                     （无需整页刷新，保持滚动位置）
```

#### 日志 SSE 推流

```
浏览器 ──GET /api/logs/stream──→ claw-monitor
                                     │
                        Content-Type: text/event-stream
                        Connection: keep-alive
                                     │
              每 2 秒检查日志文件是否有新内容：
              ├─ 记录每个文件的读取偏移量 (byte offset)
              ├─ stat() 检查文件大小是否增长
              ├─ 只读取新增的字节，解析为行
              └─ 广播给所有 SSE 客户端：
                 data: {"source":"gateway","ts":1234567890,"line":"..."}
```

---

### 2.2 FRP 隧道 (frpc ↔ frps)

将本地 :9001 暴露到公网 `claw.bfelab.com/{tenant}/`。

```
本地机器                              K8s 集群
┌──────────────┐                  ┌──────────────┐
│  claw-monitor │                  │     frps     │
│  :9001        │                  │  :7000 bind  │
│       ▲       │                  │  :19090 vhost│
│       │       │                  │       ▲      │
│   frpc 客户端  │◄── TCP 隧道 ──►│       │      │
│       │       │    (心跳 10s)    │  Nginx 反代   │
│       │       │                  │       │      │
└───────┼───────┘                  └───────┼──────┘
        │                                  │
  本地 127.0.0.1:9001                外网 claw.bfelab.com
```

#### 三层保活机制

```
┌─ 第1层：macOS LaunchAgent ────────────────────────────────────┐
│  com.bfe.claw-monitor.plist                                   │
│  KeepAlive: true → 进程退出后 OS 自动拉起（5s 延迟）            │
│                                                               │
│  ┌─ 第2层：Shell 循环 ────────────────────────────────────┐   │
│  │  startup.sh: while true; do node src/index.js; sleep 3  │  │
│  │  → Node 进程崩溃后 shell 循环自动重启                     │  │
│  │                                                         │  │
│  │  ┌─ 第3层：应用级指数退避 ─────────────────────────┐    │  │
│  │  │  FrpcService: frpc 进程退出后                    │    │  │
│  │  │  延迟 = min(3000ms × (重启次数+1), 30000ms)     │    │  │
│  │  │  运行超过 10s → 重启计数归零                      │    │  │
│  │  │  → 防止快速崩溃时的雪崩重启                       │    │  │
│  │  └────────────────────────────────────────────────┘    │  │
│  └────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────┘
```

#### frpc 配置生成

由 `services/frpc/templates.js` 生成 `data/frpc.toml`：

```toml
serverAddr = "8.135.54.217"
serverPort = 7000
loginFailExit = false                    # 登录失败不退出，持续重试

transport.heartbeatInterval = 10         # 每 10 秒心跳
transport.heartbeatTimeout = 30
transport.protocol = "tcp"

[[proxies]]
name = "monitor-v2-huangcan"
type = "http"
localIP = "127.0.0.1"
localPort = 9001
customDomains = ["claw.bfelab.com"]
locations = ["/huangcan"]                # 路径前缀路由到此代理
```

#### frpc 管理 API

| 路由 | 说明 |
|------|------|
| `GET /api/frpc/status` | 返回运行状态、PID、重启次数、版本 |
| `POST /api/frpc/start` | 启动 frpc + 保活 |
| `POST /api/frpc/stop` | 停止 frpc + 关闭保活 |
| `POST /api/frpc/install` | 自动下载安装 frpc 二进制 (GitHub Releases) |

---

### 2.3 Auth Gateway (认证网关 :4180)

运行在 K8s 集群中，保护所有租户的面板访问。

```
services/auth-gateway/
├── gateway.js              # HTTP 服务器：路由、cookie、认证流程
├── session.js              # 会话存储（改造后：MongoDB）
├── tenant.js               # 路径前缀 → 租户解析
├── db.js                   # MongoDB 连接管理（新增）
└── providers/
    ├── phone.js            # 手机验证码登录（新增）
    ├── feishu.js           # 飞书 OAuth2
    ├── wechat.js           # 微信 OAuth2
    ├── telegram.js         # Telegram Bot 验证
    └── password.js         # 简单密码
```

#### 路由表

| 路径 | 方法 | 说明 |
|------|------|------|
| `/healthz` | GET | 健康检查 → 200 |
| `/auth/check` | GET | Nginx auth_request 子请求入口 |
| `/auth/login` | GET | 展示登录页 / 跳转 OAuth |
| `/auth/send-code` | POST | 发送手机验证码（新增） |
| `/auth/callback` | GET/POST | OAuth 回调 / 验证码校验 |
| `/auth/logout` | GET | 销毁 session + 清除 cookie |

#### Provider 接口

```javascript
export default {
  // OAuth 类：返回跳转 URL
  getAuthUrl?({ redirectUri, state, config }): string,

  // 密码/手机类：返回登录表单 HTML
  renderLoginPage?({ state, rd, config }): string,

  // 验证并返回用户信息，失败返回 null
  getUser({ code, body, query, redirectUri, config }): Promise<User | null>,
}
```

---

### 2.4 FileDeck (文件浏览器)

嵌入式文件管理服务，挂载在 `/filedeck` 路径。

```
services/filedeck/
├── server.js             # Express 应用（314行）
├── public/               # 前端静态文件
└── package.json          # 独立依赖（Express）
```

| API | 说明 |
|-----|------|
| `GET /api/tree` | 根目录结构 |
| `GET /api/node?id=xxx` | 展开子目录 |
| `GET /api/file?id=xxx` | 文件内容预览（文本/JSON/Markdown/图片/PDF） |
| `GET /api/raw?id=xxx` | 原始文件下载 |

文件 ID 编码：`"root"` 或 `"n:{encodeURIComponent(相对路径)}"`

---

## 三、手机验证码登录流程（新增）

以用户访问 `claw.bfelab.com/huangcan/dashboard` 为例：

### 第1步：访问页面 → 认证检查

```
浏览器 ──GET /huangcan/dashboard──→ Nginx
                                      │
                    Nginx 发起子请求    │  auth_request
                                      ▼
                              auth-gateway /auth/check
                                      │
                          从 x-original-uri 解析租户 → "/huangcan"
                          读取 cookie: claw_session_huangcan
                          用 session ID 查 MongoDB sessions 集合
                                      │
                        ┌─────────────┴─────────────┐
                        │                           │
                   找到且未过期                   未找到/过期
                   返回 200                      返回 401
                   附带 X-Auth-User              │
                        │                        Nginx 302 重定向
                   Nginx 放行                  → /auth/login?rd=/huangcan/dashboard
                   frps → frpc → :9001              │
                        │                       进入第2步
                   用户看到面板
```

### 第2步：展示登录页

```
浏览器 ──GET /auth/login?rd=/huangcan/dashboard──→ auth-gateway
                                                       │
                                          从 rd 参数解析出租户: "/huangcan"
                                          查 tenant 配置 → authProvider = "phone"
                                                       │
                                                       ▼
                                              返回手机登录页 HTML
                                        ┌────────────────────────┐
                                        │  ┌──────────────────┐  │
                                        │  │ 手机号            │  │
                                        │  └──────────────────┘  │
                                        │  [ 获取验证码 ]         │
                                        │                        │
                                        │  ┌──────────────────┐  │
                                        │  │ 验证码            │  │
                                        │  └──────────────────┘  │
                                        │  [ 登录 ]              │
                                        └────────────────────────┘
```

### 第3步：发送验证码

```
浏览器 ──POST /auth/send-code──→ auth-gateway
         { phone: "138xxxx", tenant: "/huangcan" }
                                      │
                          ① 查 MongoDB users 集合:
                             db.users.findOne({
                               phone: "138xxxx",
                               tenants: "/huangcan"
                             })
                                      │
                        ┌─────────────┴─────────────┐
                        │                           │
                   有权限                        无权限
                        │                           │
              ② 生成 6 位随机验证码            返回 403
              ③ 写入 MongoDB codes 集合       "您没有此空间的访问权限"
                 {phone, code, tenant,
                  expiresAt: now + 5min}
              ④ 调阿里云短信 API ───→ 用户手机收到短信
                        │
                   返回 200 "验证码已发送"
```

### 第4步：提交验证码 → 创建会话

```
浏览器 ──POST /auth/callback──→ auth-gateway
         { phone: "138xxxx", code: "386721",
           rd: "/huangcan/dashboard" }
                                      │
                          ① 查 MongoDB codes 集合:
                             phone + tenant + code 匹配且未过期?
                             attempts < 5? (防暴力破解)
                                      │
                        ┌─────────────┴─────────────┐
                        │                           │
                     匹配                        不匹配
                        │                      attempts++ 或 返回 403
                        │
              ② 删除已用验证码
              ③ 生成 session ID (randomBytes(24).toString('hex'))
              ④ 写入 MongoDB sessions 集合:
                 { _id: sid,
                   phone: "138xxxx",
                   tenant: "/huangcan",
                   user: { name: "黄灿", phone: "138xxxx", provider: "phone" },
                   createdAt: now,
                   expiresAt: now + 7days }
              ⑤ Set-Cookie: claw_session_huangcan={sid}; HttpOnly; SameSite=Lax
              ⑥ 302 重定向 → /huangcan/dashboard
                        │
                   回到第1步，cookie 有效 → 直接看到面板
```

### 第5步：后续访问（自动登录，7天有效）

```
浏览器自动带上 cookie: claw_session_huangcan={sid}
         │
         ▼
Nginx → auth-gateway /auth/check
         │
         ├─ MongoDB 查 sessions: _id=sid, tenant="/huangcan"
         ├─ 未过期 → 200 ✓ → Nginx 放行 → 用户直接看到面板
         └─ 已过期 → 401   → 重新走登录流程
```

---

## 四、租户隔离设计

### 隔离方式：Cookie 名按租户区分

```
同一个浏览器，两个租户的会话完全独立：

claw.bfelab.com/huangcan/*
  └─ cookie 名: claw_session_huangcan
     └─ MongoDB: { _id:"abc123", tenant:"/huangcan", phone:"138xxxx" }

claw.bfelab.com/xiehu/*
  └─ cookie 名: claw_session_xiehu
     └─ MongoDB: { _id:"def456", tenant:"/xiehu", phone:"138xxxx" }
```

### 权限控制

```
MongoDB users 集合：
{
  phone: "13800138000",
  name: "黄灿",
  tenants: ["/huangcan", "/bfetest"]    ← 只有这两个租户的权限
}

→ 访问 /huangcan/* ✓ 允许（在 tenants 列表中）
→ 访问 /xiehu/*    ✗ 拒绝（不在 tenants 列表中，连验证码都不发）
```

### auth/check 中的租户识别

```
Nginx 传递 X-Original-URI: /huangcan/dashboard
                                │
                   解析路径前缀 → "/huangcan"
                   拼 cookie 名 → "claw_session_huangcan"
                   从请求中读取该 cookie
                   查 MongoDB 时附加 tenant 条件
```

---

## 五、MongoDB 数据模型

### users 集合（手动管理）

```javascript
{
  _id: ObjectId,
  phone: "13800138000",
  name: "黄灿",
  tenants: ["/huangcan", "/bfetest"],
  createdAt: ISODate("2026-04-01T00:00:00Z"),
  updatedAt: ISODate("2026-04-01T00:00:00Z")
}
```

### sessions 集合（自动过期）

```javascript
{
  _id: "a1b2c3d4...48位hex",           // session ID = cookie 值
  phone: "13800138000",
  tenant: "/huangcan",
  user: {
    name: "黄灿",
    phone: "13800138000",
    provider: "phone"
  },
  createdAt: ISODate("2026-04-01T10:00:00Z"),
  expiresAt: ISODate("2026-04-08T10:00:00Z")  // 7天后
}
```

### codes 集合（验证码，自动过期）

```javascript
{
  phone: "13800138000",
  tenant: "/huangcan",
  code: "386721",
  attempts: 0,                          // 错误尝试次数，≥5 则锁定
  expiresAt: ISODate("2026-04-01T10:05:00Z")  // 5分钟后
}
```

### TTL 索引（MongoDB 自动清理过期文档）

```javascript
db.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
db.codes.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
```

---

## 六、数据归属总览

| 数据 | 存储位置 | 生命周期 | 说明 |
|------|----------|----------|------|
| 用户 + 租户权限 | MongoDB `users` | 永久（手动管理） | phone + tenants[] |
| 验证码 | MongoDB `codes` | 5 分钟 TTL | 自动过期删除 |
| 会话 | MongoDB `sessions` | 7 天 TTL | 自动过期删除 |
| Session ID | 浏览器 Cookie (HttpOnly) | 随 session 过期 | 按租户区分 cookie 名 |
| 短信 | 阿里云短信 API | 发送即消 | 无持久化 |
| 面板状态 | 内存 (RingBuffer) | 进程生命周期 | 重启后重新采集 |
| 监控日志 | 本地文件 `data/` | 持久化 | 尾随读取 |
| 静态部署 | 本地文件 `data/static/` | 持久化 | 按日期/平台归档 |
| FRP 配置 | 本地文件 `data/frpc.toml` | 持久化 | 启动时自动生成 |

---

## 七、K8s 部署拓扑

```
┌─────────────────────────────────────────────────────────────────┐
│  K8s Namespace                                                  │
│                                                                 │
│  ┌─────────────────────────────────────────────┐               │
│  │  Ingress: claw.bfelab.com                   │               │
│  │  (3 条规则，见第一章)                         │               │
│  └─────────┬────────────────────┬──────────────┘               │
│            │                    │                               │
│            ▼                    ▼                               │
│  ┌─────────────────┐  ┌─────────────────┐                     │
│  │ Service          │  │ Service          │                     │
│  │ auth-gateway     │  │ frps             │                     │
│  │ :4180            │  │ :7000 + :19090   │                     │
│  └────────┬─────────┘  └────────┬─────────┘                     │
│           │                     │                               │
│           ▼                     ▼                               │
│  ┌─────────────────┐  ┌─────────────────┐                     │
│  │ Deployment       │  │ Deployment       │                     │
│  │ auth-gateway     │  │ frps             │                     │
│  │ 1 replica        │  │ 1 replica        │                     │
│  │ 50m/64Mi req     │  │ 100m/128Mi req   │                     │
│  │ 200m/128Mi lim   │  │ 500m/256Mi lim   │                     │
│  │                  │  │                  │                     │
│  │ ConfigMap:       │  │ ConfigMap:       │                     │
│  │  租户+provider   │  │  frps.toml       │                     │
│  │  配置            │  │  bindPort=7000   │                     │
│  │                  │  │  vhost=19090     │                     │
│  │ Probes:          │  │                  │                     │
│  │  /healthz 30s    │  │                  │                     │
│  └─────────────────┘  └─────────────────┘                     │
│                                                                 │
│  ┌─────────────────┐                                           │
│  │ MongoDB          │  ← 新增：sessions/users/codes            │
│  │ (已有实例)        │                                           │
│  └─────────────────┘                                           │
└─────────────────────────────────────────────────────────────────┘
```

---

## 八、端到端请求链路示例

### 场景：黄灿首次访问面板

```
① 浏览器 GET claw.bfelab.com/huangcan/dashboard
   │
② Nginx Ingress 匹配规则3（需认证）
   ├─ 子请求 → auth-gateway:4180/auth/check
   │           X-Original-URI: /huangcan/dashboard
   │           Cookie: (无)
   │           → 返回 401
   │
③ Nginx 302 → /auth/login?rd=/huangcan/dashboard
   │
④ 浏览器 GET /auth/login?rd=/huangcan/dashboard
   ├─ Nginx 匹配规则1 → auth-gateway:4180
   ├─ 解析 rd → 租户 "/huangcan" → provider "phone"
   └─ 返回手机登录页 HTML
   │
⑤ 用户输入手机号，点击获取验证码
   ├─ 浏览器 POST /auth/send-code {phone, tenant}
   ├─ auth-gateway 查 MongoDB users → 有权限
   ├─ 生成验证码 → 存 MongoDB codes
   ├─ 调阿里云 SMS API → 手机收到短信
   └─ 返回 200
   │
⑥ 用户输入验证码，点击登录
   ├─ 浏览器 POST /auth/callback {phone, code, rd}
   ├─ auth-gateway 查 MongoDB codes → 匹配
   ├─ 创建 session → 写 MongoDB sessions
   ├─ Set-Cookie: claw_session_huangcan=sid
   └─ 302 → /huangcan/dashboard
   │
⑦ 浏览器 GET /huangcan/dashboard (带 cookie)
   ├─ Nginx 子请求 → auth-gateway /auth/check → 200 ✓
   ├─ Nginx 放行 → frps:19090
   ├─ frps 路由 /huangcan/* → frpc 隧道
   ├─ frpc 转发 → 127.0.0.1:9001
   ├─ claw-monitor 匹配路由 GET /
   ├─ renderFull(panels) → 完整 HTML 页面
   └─ 返回监控面板
   │
⑧ 面板自动刷新
   └─ 每 3 秒 fetch /huangcan/api/html → 只更新面板区域
```

### 场景：黄灿第二天再次访问（自动登录）

```
① 浏览器 GET claw.bfelab.com/huangcan/dashboard
   Cookie: claw_session_huangcan=sid
   │
② Nginx 子请求 → auth-gateway /auth/check
   ├─ 读 cookie → sid
   ├─ 查 MongoDB sessions → 未过期 → 200 ✓
   │
③ Nginx 放行 → frps → frpc 隧道 → :9001 → 面板 HTML
   │
   整个过程对用户透明，无需再次登录
```

---

## 九、配置示例

```json
{
  "port": 9001,
  "instanceName": "huangcan",

  "health": {
    "enabled": true,
    "url": "http://127.0.0.1:18789/health",
    "intervalMs": 5000,
    "timeoutMs": 5000,
    "failThreshold": 3
  },

  "ping": {
    "enabled": true,
    "targets": [
      { "name": "Google", "url": "https://www.google.com" },
      { "name": "Baidu", "url": "https://www.baidu.com" }
    ]
  },

  "codexUsage": {
    "enabled": true,
    "intervalMs": 300000
  },

  "logs": {
    "maxEntries": 500,
    "sources": [
      { "name": "gateway", "path": "~/.openclaw/logs/gateway.log" },
      { "name": "errors", "path": "~/.openclaw/logs/gateway.err.log" }
    ]
  },

  "deploy": {
    "staticDir": "./data/static"
  },

  "frpc": {
    "serverAddr": "8.135.54.217",
    "serverPort": 7000,
    "transport": {
      "heartbeatInterval": 10,
      "heartbeatTimeout": 30
    },
    "proxies": [{
      "name": "monitor-v2-huangcan",
      "type": "http",
      "localIP": "127.0.0.1",
      "localPort": 9001,
      "customDomains": ["claw.bfelab.com"],
      "locations": ["/huangcan"]
    }]
  },

  "authGateway": {
    "port": 4180,
    "sessionTtlMs": 604800000,
    "mongodb": {
      "uri": "mongodb://user:pass@host:27017",
      "database": "claw_auth"
    },
    "sms": {
      "accessKeyId": "YOUR_ALIYUN_AK",
      "accessKeySecret": "YOUR_ALIYUN_SK",
      "signName": "你的短信签名",
      "templateCode": "SMS_xxxxxxx"
    },
    "tenants": {
      "/huangcan": {
        "authProvider": "phone",
        "provider": {}
      },
      "/xiehu": {
        "authProvider": "phone",
        "provider": {}
      },
      "/bfetest": {
        "authProvider": "feishu",
        "provider": {
          "appId": "cli_...",
          "appSecret": "..."
        }
      }
    }
  }
}
```

---

## 十、改动范围（手机登录改造）

```
services/auth-gateway/
├── gateway.js              # 改：cookie 按租户区分，新增 /auth/send-code 路由
├── session.js              # 重写：内存 Map → MongoDB sessions 集合
├── tenant.js               # 小改：暴露 tenant prefix 用于 cookie 命名
├── db.js                   # 新增：MongoDB 连接管理
├── providers/
│   ├── phone.js            # 新增：权限校验 + 验证码收发 + 阿里云 SMS
│   ├── feishu.js           # 保留
│   ├── wechat.js           # 保留
│   └── telegram.js         # 保留
└── login.html              # 新增：手机验证码两步登录 UI
```
