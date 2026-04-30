# Hub 设计文档

## 项目定位

`services/hub` 是一个**纯前端**——仅有 HTML/CSS/JS 三件套，给 tailnet 内的用户提供一个浏览/下载已发布应用的 Web UI。

- 不再有自己的后端进程或 express 模块
- 不再读写 `~/.bfe-hub/`（那是 puller 的事）
- 不再处理鉴权、上传、版本清理（那也是 puller 的事）

UI 的所有动态数据都来自 [`claw-hub-puller`](https://github.com/MindedCoder/claw-hub-puller) 这个独立服务，由 monitor 反代/转发。

## 与配套服务的关系

```
┌──────────────────────┐
│  浏览器              │  https://claw.bfelab.com/<instance>/hub/
└──────────┬───────────┘
           │ 1. 静态资源 + /hub/api/*
           ↓
┌──────────────────────┐
│  monitor :9001       │  唯一对外入口（一条 frpc proxy）
│  (claw-monitor_v2)   │
│                      │
│  /hub/               → services/hub/public/ 静态文件
│  /hub/api/meta       → 本地合成（instanceName / title）
│  /hub/api/apps...    → fetch(PULLER_URL/api/...)
│  /hub-puller/*       → http.request → 127.0.0.1:8126
└──────────┬───────────┘
           │ 2a. 读路径：fetch
           │ 2b. 写路径（webhook / 跨 host hub）：反代
           ↓
┌──────────────────────┐
│  claw-hub-puller     │  独立进程，单一数据源
│       :8126          │  GitHub webhook 触发同步
│                      │  写 ~/.bfe-hub/apps/，自己也读
└──────────────────────┘
```

`services/hub/` 的代码归 monitor，但**只剩静态文件**；hub 的「后端」其实就是 puller。

## 部署模型

- 整个 fleet 部署**一份** puller（生产实例名 `monitor`）；其余 host 只跑 monitor，不跑 puller
- 每个 host 的 monitor 都挂载 `/hub` 静态前端，所以从任意 host 访问 `<host>/hub/` 都能用
- 数据来源由 monitor 上的 `HUB_PULLER_URL` env 决定：
  - puller 同机：`http://127.0.0.1:8126`（绕开 frpc，直连本地 puller）
  - puller 异机：`https://claw.bfelab.com/<puller-host-instance>/hub-puller`
  - 默认：`https://claw.bfelab.com/monitor/hub-puller`（生产 puller 的位置，不带 env 即用此值）

## monitor 路由（src/server.js）

monitor 的 HTTP 处理顺序里，`/hub-puller/*` 必须在 `/hub` 之前判断（因为 `/hub-puller` 也 `startsWith('/hub')`）。

### `/hub-puller/*` 反代块

把 `/<instance>/hub-puller/api/foo` 这种公网请求剥掉前缀转给本机 puller：

```js
if (path.startsWith('/hub-puller')) {
  const forwardedPath = path.slice('/hub-puller'.length) || '/';
  const upstream = http.request({
    host: '127.0.0.1', port: 8126,
    method: req.method,
    path: `${forwardedPath}${url.search || ''}`,
    headers: { ...req.headers, host: '127.0.0.1:8126' },
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on('error', /* 502 */);
  req.pipe(upstream);
  return;
}
```

为什么用 `http.request` 而不是 `fetch`：
- **GitHub webhook 需要 raw body 做 HMAC**——`req.pipe(upstream)` 让 body 透明流过去，puller 那侧 `express.raw()` 拿到的就是原始字节
- **下载支持 `Range`**——双向 pipe 自动透传 `Range` 请求头和 `Content-Range` 响应头，无需逐个白名单

### `/hub/*` 块

```js
if (path.startsWith('/hub')) {
  if (path === '/hub') 301 → /<instance>/hub/;

  const subPath = path.slice('/hub'.length);

  // /hub/api/meta：本地合成（属于本机 monitor，不是 puller 的数据）
  if (subPath === '/api/meta') {
    return sendJson(res, {
      instanceName: config.instanceName,
      title: 'BFE Hub',
      uploadsEnabled: false,
    });
  }

  // /hub/api/*：fetch 到 PULLER_URL，Readable.fromWeb 流式回写
  if (subPath.startsWith('/api/')) {
    return proxyHubApiToPuller(req, res, subPath, url.search);
  }

  // 其他：从 services/hub/public/ 拿静态文件
  return serveFromDir(HUB_PUBLIC_DIR, subPath || 'index.html', res);
}
```

为什么读 API 用 `fetch(PULLER_URL)` 而不是统一用 `http.request 到 8126`：
- **跨 host 兼容**——非 puller host 上的 monitor 没有本地 puller，必须走公网
- 同 host 时也可以让 `HUB_PULLER_URL=http://127.0.0.1:8126` 短路，性能差异可忽略

转发的响应头：`content-type / content-length / content-range / content-disposition / accept-ranges / etag / last-modified / location`。

## 环境变量

| 名字 | 默认 | 作用 |
|---|---|---|
| `HUB_PULLER_URL` | `https://claw.bfelab.com/monitor/hub-puller` | hub 的 `/hub/api/*` 路由 fetch 哪个 puller |

`HUB_PULLER_URL` 在 monitor 启动时读取（`src/server.js` 模块加载阶段），所以**必须在启动那一刻就存在**。LaunchAgent 不会继承 shell 的 env，要持久化必须写到：
- `~/Library/LaunchAgents/com.claw-monitor-v2.monitor.plist` 的 `EnvironmentVariables` 字典
- 以及 `~/.bfe/claw-monitor_v2/data/startup.sh` 里的 `export ...`

## frpc proxy 配置

整个 host 只一条：

```json
{
  "name": "monitor-v2-${INSTANCE}",
  "type": "http",
  "localIP": "127.0.0.1",
  "localPort": 9001,
  "customDomains": ["claw.bfelab.com"],
  "locations": ["/${INSTANCE}"]
}
```

不再为 puller 单独开 proxy——puller 暴露给公网的入口就是 `claw.bfelab.com/<instance>/hub-puller/*`，由 monitor 上面那段反代实现。

## 鉴权

hub 自身不参与鉴权。安全边界由 nginx ingress + auth-gateway 决定：
- `/hub/`（前端 HTML/CSS/JS）：走 auth-gateway 登录拦截，未登录跳到 `/auth/login`
- `/hub/api/*`：被 auth-gateway 的 `/api/` 偷懒放行规则覆盖，匿名可达——内部网络（tailnet/k8s）认为可信
- `/hub-puller/*`：同上，`/api/` 放行——这是有意的，GitHub webhook 必须能匿名打通；安全性由 puller 自己的 HMAC 验签保证

## 文件清单

```
services/hub/
├── DESIGN.md              ← 本文件
└── public/
    ├── index.html
    ├── styles.css
    └── app.js             ← SPA：hash 路由 / 列表 / 详情 / 下载
```

不再有 `server.js`、`lib/`、`package.json`、`node_modules/`——这些都在前几次重构中删掉了。

## 前端约定（public/app.js）

- **API 前缀推导**：基于当前页面路径推导，使得 `claw.bfelab.com/<instance>/hub/` 和直接打 `/<instance>/hub/` 都能正常 fetch（沿用 filedeck 的同一原则）
- **`/api/meta`**：先于其他请求拉一次，缓存 `instanceName` / `title` 到本地变量，UI 标题和 host tag 渲染用
- **没有上传/删除入口**——上传 UI 早已屏蔽（FAB / 详情页按钮 / `#/upload` 路由）；删除按钮也屏蔽了。要清理由 puller 那侧 `cli` 操作

## 开发约束

- 改前端：直接编辑 `public/` 三件套即可；浏览器 hard-refresh 看变化
- 本地调试：在 zytest（puller 同机的开发机）跑 monitor 时，env 里 `HUB_PULLER_URL=http://127.0.0.1:8126` 短路，避免数据走一圈公网回环
- **禁止**在开发机上创建 `~/.bfe-hub/`——所有数据都该出现在 puller host 上；这条规矩没变
- 不要在 hub 这边再加任何 node 依赖——它就该保持静态资源那么干净

## 与旧设计的差异（从迁移角度）

| 老 | 新 |
|---|---|
| hub 自己 express server `:8125` | 没有进程，前端由 monitor 直接 serve |
| `lib/storage.js` 读写 `~/.bfe-hub/apps` | 删除，apps 目录归 puller 管 |
| 上传分片续传 / 删除接口 | 删除，发布走 GitHub webhook → puller |
| `HUB_REQUIRE_AUTH` / `HUB_UPLOADS_ENABLED` | 删除 |
| 单中心：所有人访问唯一 hub host | hub 前端可在每个 host 部署，数据中心化在 puller |
| frpc 多 proxy（monitor + hub 直连 + 后来加的 hub-puller） | 单 proxy（monitor），其他端口由 monitor 反代 |

## 相关文档

- [claw-hub-puller DESIGN.md](https://github.com/MindedCoder/claw-hub-puller/blob/main/DESIGN.md) ——发布侧细节
- [claw-hub-puller SPEC.md](https://github.com/MindedCoder/claw-hub-puller/blob/main/SPEC.md) ——`.bfehub.json` 字段契约
