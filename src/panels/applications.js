import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sendJson, readBody } from '../lib/http-helpers.js';
import { APPLICATIONS_STORE_DIR, loadApplications, saveApplications } from '../lib/applications-store.js';

const APP_DATA_MAX_BYTES = 256 * 1024;

const ICON_COLORS = [
  '#3370ff', '#5b8def', '#7c5cff', '#a657ff', '#d65cff',
  '#ff5c8a', '#ff7a45', '#ff9f43', '#f0b100', '#55c24e',
  '#14b8a6', '#22c1c3', '#ff6b6b', '#f06292', '#9575cd',
];

// progress.txt 事件 -> (累积百分比, 直白中文描述)
// 由 claw-application-skill 写入；这里只读不写。
// 文案目标：非技术用户也能看懂，避免"自查 / 归档 / 已注册"这类内部术语。
const PROGRESS_EVENTS = {
  STAGE2_START:        [5,   '应用已创建，准备开始制作...'],
  PLAN_ARCHIVED:       [10,  '设计方案已存档'],
  ICON_GENERATED:      [25,  '图标已画好'],
  ICON_INSTALLED:      [35,  '图标已上传'],
  ICON_SKIPPED:        [35,  '图标生成失败，已用纯色代替'],
  FILES_WRITTEN:       [65,  '页面已写好'],
  HTTP_VERIFIED:       [75,  '应用可访问'],
  STAGE2_DONE:         [80,  '应用本体完成，开始检查质量'],
  STAGE3_START:        [82,  '正在检查质量...'],
  SELF_CHECK_PASS:     [95,  '质量检查通过'],
  STAGE3_DONE:         [100, '已完成 ✅'],
  STAGE3_FORCE_PASS:   [100, '已完成 ✅（部分项未达标但已放行）'],
};
const DONE_EVENTS = new Set(['STAGE3_DONE', 'STAGE3_FORCE_PASS']);

// 解析 ~/.openclaw/workspace/applications/<id>/progress.txt 并返回结构化进度对象。
// 提到模块级（不依赖 panel closure），让 server.js 也能复用。
export function readProgress(appId) {
  const progressPath = resolve(APPLICATIONS_STORE_DIR, appId, 'progress.txt');
  if (!existsSync(progressPath)) return null;
  let text;
  try {
    text = readFileSync(progressPath, 'utf8');
  } catch {
    return null;
  }
  const lines = text.split('\n').filter(Boolean);
  if (lines.length === 0) return null;

  const firstMatch = lines[0].match(/^\[([^\]]+)\]/);
  const startedAt = firstMatch ? firstMatch[1] : null;

  // 已完成 → 永远定格在 100%，不被 Mode B/C 后续追加的事件干扰
  let doneEvent = null;
  for (const l of lines) {
    const m = l.match(/^\[[^\]]+\]\s+(\w+)/);
    if (m && DONE_EVENTS.has(m[1])) {
      doneEvent = m[1];
      break;
    }
  }
  if (doneEvent) {
    const [percent, stage] = PROGRESS_EVENTS[doneEvent];
    return { status: 'done', percent, stage, startedAt };
  }

  let lastEvent = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^\[[^\]]+\]\s+(\w+)/);
    if (m && PROGRESS_EVENTS[m[1]]) {
      lastEvent = m[1];
      break;
    }
  }
  if (!lastEvent) return null;

  const [percent, stage] = PROGRESS_EVENTS[lastEvent];
  return { status: 'creating', percent, stage, startedAt };
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 渲染 /applications/<id>/progress 的 HTML 页面。
// done 时省去 meta refresh + 显示"打开应用"链接；creating 时 meta refresh 3 秒。
export function renderProgressPage(appId) {
  const progress = readProgress(appId);
  if (!progress) return null;

  // 拿应用 name（用于标题）
  let name = appId.slice(0, 6).toUpperCase();
  try {
    const apps = loadApplications();
    const app = apps.find((a) => a.id === appId);
    if (app && app.name) name = app.name;
  } catch {
    /* fall through with placeholder */
  }

  const elapsedSecs = progress.startedAt
    ? Math.max(0, Math.round((Date.now() - new Date(progress.startedAt).getTime()) / 1000))
    : null;
  const elapsedStr = elapsedSecs == null
    ? ''
    : elapsedSecs < 60
      ? `${elapsedSecs} 秒`
      : `${Math.floor(elapsedSecs / 60)} 分 ${elapsedSecs % 60} 秒`;

  const isDone = progress.status === 'done';
  const safeName = escapeHtml(name);
  const safeStage = escapeHtml(progress.stage);
  const safeId = escapeHtml(appId);

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeName} · 进度</title>
<style>
  :root{
    --cyan:#00f0ff; --cyan-soft:rgba(0,240,255,.18);
    --magenta:#ff2d95;
    --text:#e8e8f7; --text-dim:#8a8ab4;
    --border:rgba(0,240,255,.22); --border-hover:rgba(0,240,255,.7);
    --card:rgba(14,12,36,.72);
    --bg-0:#03020f; --bg-1:#0a0712;
    --mono: ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace;
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{
    background: radial-gradient(ellipse at top, #1a0b2e 0%, var(--bg-1) 50%, var(--bg-0) 100%);
    color:var(--text); min-height:100vh;
    display:flex; align-items:center; justify-content:center;
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
    padding:20px;
  }
  .panel{
    position:relative; max-width:480px; width:100%;
    padding:32px 28px;
    background:var(--card);
    border:1px solid var(--border);
    backdrop-filter: blur(8px);
    box-shadow:
      0 0 0 1px var(--cyan-soft),
      0 10px 40px rgba(0,240,255,.12),
      inset 0 0 60px rgba(0,240,255,.04);
  }
  .panel::before, .panel::after{
    content:""; position:absolute; width:14px; height:14px;
    border-color: var(--cyan); border-style: solid; pointer-events: none;
  }
  .panel::before{ top:6px; left:6px; border-width:1px 0 0 1px; }
  .panel::after{ bottom:6px; right:6px; border-width:0 1px 1px 0; }
  .tag{
    font-family: var(--mono); font-size:10px; letter-spacing:.12em;
    color: var(--cyan); text-transform: uppercase;
    margin-bottom:6px;
  }
  .name{
    font-size:24px; font-weight:600; margin:0 0 24px;
    letter-spacing:.02em;
  }
  .done-banner{
    font-size:14px; color:#55c24e; margin-bottom:18px;
    padding:10px 14px; border:1px solid rgba(85,194,78,.35);
    background:rgba(85,194,78,.08);
  }
  .stage{
    font-family: var(--mono); font-size:12px; letter-spacing:.06em;
    color: var(--text-dim); text-transform: uppercase;
    margin-bottom:10px;
    min-height: 1.2em;
  }
  .bar{
    height:6px; background:rgba(255,255,255,.06);
    border:1px solid var(--border); overflow:hidden;
    margin-bottom:14px;
  }
  .fill{
    height:100%;
    background: linear-gradient(90deg, var(--cyan), var(--magenta));
    box-shadow: 0 0 12px rgba(0,240,255,.5);
    transition: width .5s ease;
  }
  .percent{
    font-family: var(--mono); font-size:42px;
    color: var(--magenta);
    font-variant-numeric: tabular-nums;
    letter-spacing:.02em;
  }
  .meta{
    font-family: var(--mono); font-size:11px; color: var(--text-dim);
    margin-top:20px; padding-top:16px;
    border-top:1px dashed var(--border);
    display:flex; justify-content:space-between; gap:12px;
  }
  .links{
    margin-top:20px; display:flex; gap:10px; flex-wrap:wrap;
  }
  .links a{
    font-family: var(--mono); font-size:11px; letter-spacing:.06em;
    text-transform: uppercase;
    color: var(--cyan); text-decoration:none;
    padding:8px 12px; border:1px solid var(--border);
    transition: border-color .2s, color .2s;
  }
  .links a:hover{
    border-color: var(--border-hover); color: var(--magenta);
  }
  .links a.primary{
    color: var(--magenta); border-color: rgba(255,45,149,.35);
  }
  .links a.primary:hover{
    border-color: var(--magenta);
  }
</style>
</head>
<body data-app-id="${safeId}" data-initial-done="${isDone ? '1' : '0'}">
  <main class="panel">
    <div class="tag">PROGRESS / ID://${safeId.slice(0, 6).toUpperCase()}</div>
    <div class="name">${safeName}</div>
    <div class="done-banner" id="done-banner" ${isDone ? '' : 'hidden'}>✅ 已完成</div>
    <div class="stage" id="stage">${safeStage}</div>
    <div class="bar"><div class="fill" id="fill" style="width:${progress.percent}%"></div></div>
    <div class="percent" id="percent">${progress.percent}%</div>
    <div class="meta">
      <span>开始于 ${escapeHtml(progress.startedAt || '-')}</span>
      <span id="elapsed">${elapsedStr ? '已耗时 ' + elapsedStr : '-'}</span>
    </div>
    <div class="links" id="links">
      <a class="primary" id="open-app-link" href="./" ${isDone ? '' : 'hidden'}>→ 打开应用</a>
      <a href="./progress.txt">原始日志</a>
      <a href="../">返回列表</a>
    </div>
  </main>
<script>
(function(){
  const APP_ID = document.body.dataset.appId;
  let isDone = document.body.dataset.initialDone === '1';
  let pollTimer = null;
  const POLL_INTERVAL = 3000;

  const fill = document.getElementById('fill');
  const percentEl = document.getElementById('percent');
  const stageEl = document.getElementById('stage');
  const elapsedEl = document.getElementById('elapsed');
  const banner = document.getElementById('done-banner');
  const openAppLink = document.getElementById('open-app-link');

  function fmtElapsed(secs) {
    if (secs < 60) return '已耗时 ' + secs + ' 秒';
    return '已耗时 ' + Math.floor(secs/60) + ' 分 ' + (secs%60) + ' 秒';
  }

  async function tick() {
    try {
      const res = await fetch('../../api/applications/detail?id=' + encodeURIComponent(APP_ID));
      if (!res.ok) return;
      const app = await res.json();
      const p = app && app.progress;
      if (!p) return;

      fill.style.width = p.percent + '%';
      percentEl.textContent = p.percent + '%';
      stageEl.textContent = p.stage;

      if (p.startedAt) {
        const elapsed = Math.max(0, Math.round((Date.now() - new Date(p.startedAt).getTime()) / 1000));
        elapsedEl.textContent = fmtElapsed(elapsed);
      }

      if (p.status === 'done' && !isDone) {
        isDone = true;
        banner.hidden = false;
        openAppLink.hidden = false;
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      }
    } catch {}
  }

  if (!isDone) {
    pollTimer = setInterval(tick, POLL_INTERVAL);
  }

  // 切回前台时立即拉一次（避免后台太久回来看到旧数据）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !isDone) {
      tick();
      if (!pollTimer) pollTimer = setInterval(tick, POLL_INTERVAL);
    } else if (document.visibilityState === 'hidden' && pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });
})();
</script>
</body>
</html>`;
}

export default function createApplicationsPanel(config) {
  const storeDir = APPLICATIONS_STORE_DIR;

  function ensureStore() {
    if (!existsSync(storeDir)) mkdirSync(storeDir, { recursive: true });
  }

  function loadAll() {
    ensureStore();
    return loadApplications();
  }

  function saveAll(list) {
    ensureStore();
    saveApplications(list);
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function scaffoldAppFolder(app) {
    const appDir = resolve(storeDir, app.id);
    if (existsSync(appDir)) return;
    mkdirSync(appDir, { recursive: true });
    const indexPath = resolve(appDir, 'index.html');
    writeFileSync(indexPath, renderPlaceholderIndex(app), 'utf8');
  }

  function appDataPath(id) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
    return resolve(storeDir, id, 'data.json');
  }

  function readAppData(id) {
    const dataPath = appDataPath(id);
    if (!dataPath || !existsSync(dataPath)) return {};
    try {
      const parsed = JSON.parse(readFileSync(dataPath, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function renderPlaceholderIndex(app) {
    const name = escapeHtml(app.name);
    const description = escapeHtml(app.description);
    return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${name}</title>
<style>
  body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif; color:#1f2329; background:#fff; }
  main { max-width:720px; margin:48px auto; padding:0 24px; }
  h1 { font-size:22px; margin:0 0 16px; }
  p { line-height:1.7; color:#4e5969; white-space:pre-wrap; }
  .hint { margin-top:24px; padding:12px 16px; background:#f5f6f7; border-radius:8px; color:#8f959e; font-size:13px; }
  a.back { display:inline-block; margin-bottom:24px; font-size:13px; color:#3370ff; text-decoration:none; }
  a.back:hover { text-decoration:underline; }
</style>
</head>
<body>
<main>
  <a class="back" href="../">← 返回全部应用</a>
  <h1>${name}</h1>
  <p>${description}</p>
  <p class="hint">小龙虾正在为你生成应用界面，稍后请刷新。</p>
</main>
</body>
</html>
`;
  }

  function generateId() {
    return randomBytes(6).toString('hex');
  }

  function randomIconColor() {
    return ICON_COLORS[Math.floor(Math.random() * ICON_COLORS.length)];
  }

  function isValidName(name) {
    return typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 40;
  }

  function isValidDescription(desc) {
    return typeof desc === 'string' && desc.trim().length > 0 && desc.trim().length <= 2000;
  }

  function isValidIconDataUrl(value) {
    if (value == null) return true;
    if (typeof value !== 'string') return false;
    if (!/^data:image\/(png|jpe?g|webp|svg\+xml);base64,/i.test(value)) return false;
    return value.length <= 800 * 1024; // ~600KB binary after base64 decode
  }

  function publicView(app) {
    return {
      id: app.id,
      name: app.name,
      description: app.description,
      icon: app.icon || null,
      iconColor: app.iconColor || null,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
      progress: readProgress(app.id),
    };
  }

  function findByName(list, name, excludeId = null) {
    const normalized = name.trim();
    return list.find((a) => a.name === normalized && a.id !== excludeId);
  }

  function routes() {
    return {
      'GET /api/applications/list': (req, res) => {
        const list = loadAll().map(publicView);
        sendJson(res, { applications: list });
      },

      'GET /api/applications/detail': (req, res, url) => {
        const id = url.searchParams.get('id');
        if (!id) return sendJson(res, { error: 'id required' }, 400);
        const list = loadAll();
        const found = list.find((a) => a.id === id);
        if (!found) return sendJson(res, { error: 'not found' }, 404);
        sendJson(res, publicView(found));
      },

      'POST /api/applications/create': async (req, res) => {
        const body = await readBody(req);
        if (!body) return sendJson(res, { error: 'invalid json' }, 400);

        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const description = typeof body.description === 'string' ? body.description.trim() : '';

        if (!isValidName(name)) return sendJson(res, { error: '应用名称不合法（1-40 字符）' }, 400);
        if (!isValidDescription(description)) return sendJson(res, { error: '功能描述不合法（1-2000 字符）' }, 400);
        if (!isValidIconDataUrl(body.icon)) return sendJson(res, { error: '图标格式不合法或超过 600KB' }, 400);

        const list = loadAll();
        if (findByName(list, name)) return sendJson(res, { error: '应用名称已存在' }, 409);

        const now = new Date().toISOString();
        const app = {
          id: generateId(),
          name,
          description,
          icon: body.icon || null,
          iconColor: body.icon ? null : randomIconColor(),
          createdAt: now,
          updatedAt: now,
        };
        list.push(app);
        saveAll(list);
        scaffoldAppFolder(app);
        sendJson(res, publicView(app));
      },

      'POST /api/applications/update': async (req, res) => {
        const body = await readBody(req);
        if (!body) return sendJson(res, { error: 'invalid json' }, 400);

        const id = typeof body.id === 'string' ? body.id : '';
        if (!id) return sendJson(res, { error: 'id required' }, 400);

        const list = loadAll();
        const index = list.findIndex((a) => a.id === id);
        if (index === -1) return sendJson(res, { error: 'not found' }, 404);

        const current = list[index];
        const next = { ...current };

        if (body.name !== undefined) {
          const name = typeof body.name === 'string' ? body.name.trim() : '';
          if (!isValidName(name)) return sendJson(res, { error: '应用名称不合法（1-40 字符）' }, 400);
          if (findByName(list, name, id)) return sendJson(res, { error: '应用名称已存在' }, 409);
          next.name = name;
        }

        if (body.description !== undefined) {
          const description = typeof body.description === 'string' ? body.description.trim() : '';
          if (!isValidDescription(description)) return sendJson(res, { error: '功能描述不合法（1-2000 字符）' }, 400);
          next.description = description;
        }

        if (body.icon !== undefined) {
          if (body.icon === null || body.icon === '') {
            next.icon = null;
            if (!next.iconColor) next.iconColor = randomIconColor();
          } else {
            if (!isValidIconDataUrl(body.icon)) return sendJson(res, { error: '图标格式不合法或超过 600KB' }, 400);
            next.icon = body.icon;
            next.iconColor = null;
          }
        }

        if (body.iconColor !== undefined && !next.icon) {
          if (typeof body.iconColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(body.iconColor)) {
            return sendJson(res, { error: 'iconColor 必须是 #RRGGBB' }, 400);
          }
          next.iconColor = body.iconColor;
        }

        next.updatedAt = new Date().toISOString();
        list[index] = next;
        saveAll(list);
        sendJson(res, publicView(next));
      },

      'GET /api/applications/data': (req, res, url) => {
        const id = url.searchParams.get('id');
        if (!id) return sendJson(res, { error: 'id required' }, 400);
        const list = loadAll();
        if (!list.find((a) => a.id === id)) return sendJson(res, { error: 'not found' }, 404);
        sendJson(res, readAppData(id));
      },

      'PUT /api/applications/data': async (req, res, url) => {
        const id = url.searchParams.get('id');
        if (!id) return sendJson(res, { error: 'id required' }, 400);

        const list = loadAll();
        if (!list.find((a) => a.id === id)) return sendJson(res, { error: 'not found' }, 404);

        const declared = Number(req.headers['content-length'] || 0);
        if (declared && declared > APP_DATA_MAX_BYTES) {
          return sendJson(res, { error: `data exceeds ${APP_DATA_MAX_BYTES} bytes` }, 413);
        }

        const chunks = [];
        let received = 0;
        let aborted = false;
        req.on('data', (chunk) => {
          if (aborted) return;
          received += chunk.length;
          if (received > APP_DATA_MAX_BYTES) {
            aborted = true;
            sendJson(res, { error: `data exceeds ${APP_DATA_MAX_BYTES} bytes` }, 413);
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        req.on('end', () => {
          if (aborted) return;
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed;
          try {
            parsed = JSON.parse(raw);
          } catch {
            return sendJson(res, { error: 'body must be valid JSON' }, 400);
          }
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return sendJson(res, { error: 'body must be a JSON object' }, 400);
          }
          const appDir = resolve(storeDir, id);
          if (!existsSync(appDir)) mkdirSync(appDir, { recursive: true });
          try {
            writeFileSync(resolve(appDir, 'data.json'), JSON.stringify(parsed), 'utf8');
          } catch (err) {
            return sendJson(res, { error: `write failed: ${err.message}` }, 500);
          }
          sendJson(res, { ok: true });
        });
        req.on('error', () => {
          if (!aborted) sendJson(res, { error: 'request error' }, 400);
        });
      },
    };
  }

  return {
    name: 'applications',
    render: () => '',
    routes,
  };
}
