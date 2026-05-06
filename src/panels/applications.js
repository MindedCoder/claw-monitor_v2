import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
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
