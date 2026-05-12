import http from 'node:http';
import { Readable } from 'node:stream';
import { createRequire } from 'node:module';
import { parseUrl, sendJson, sendHtml, send404, sendText } from './lib/http-helpers.js';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import os from 'node:os';
import {
  APPLICATIONS_PUBLIC_DIR,
  APPLICATIONS_STORE_DIR,
} from './lib/applications-store.js';
import { renderProgressPage } from './panels/applications.js';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

let filedeckApp;
try {
  filedeckApp = require('../services/filedeck/server.js');
} catch {
  // filedeck not available, skip
}

// services/hub is a pure-frontend bundle (HTML/CSS/JS in services/hub/public).
// Static files are served from here; the frontend's /api/* calls are
// reverse-proxied to claw-hub-puller (PULLER_URL). Puller is the single
// source of truth for app data; monitor only ferries the requests.
const HUB_PUBLIC_DIR = join(__dirname, '../services/hub/public');
const PULLER_URL = (
  process.env.HUB_PULLER_URL || 'https://claw.bfelab.com/monitor/hub-puller'
).replace(/\/+$/, '');
console.log(`[hub] PULLER_URL=${PULLER_URL}`);
const LOCAL_BFE_HUB_REGISTRY = join(os.homedir(), '.bfe', 'bfe-hub', 'registry.json');

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

const PROXY_FORWARD_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'content-disposition',
  'accept-ranges',
  'etag',
  'last-modified',
  'location',
];

async function proxyHubApiToPuller(req, res, subPath, search) {
  const upstreamUrl = `${PULLER_URL}${subPath}${search}`;
  const upstreamHeaders = {};
  if (req.headers.range) upstreamHeaders.range = req.headers.range;
  if (req.headers['if-none-match']) {
    upstreamHeaders['if-none-match'] = req.headers['if-none-match'];
  }
  let upstream;
  try {
    upstream = await fetch(upstreamUrl, { headers: upstreamHeaders, redirect: 'manual' });
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    res.end(JSON.stringify({ error: `puller unreachable: ${err.message}` }));
    return;
  }
  const headers = {};
  for (const h of PROXY_FORWARD_HEADERS) {
    const v = upstream.headers.get(h);
    if (v) headers[h] = v;
  }
  res.writeHead(upstream.status, headers);
  if (upstream.body) {
    Readable.fromWeb(upstream.body).pipe(res);
  } else {
    res.end();
  }
}

async function readInstalledApps() {
  let raw = '{}';
  try {
    raw = await fsp.readFile(LOCAL_BFE_HUB_REGISTRY, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { apps: [] };
    throw error;
  }

  let parsed = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }

  const apps = Object.entries(parsed)
    .map(([appId, entry]) => ({
      appId,
      currentVersion: entry?.currentVersion || '',
      declaredVersion: entry?.declaredVersion || '',
      platform: entry?.platform || '',
      artifactType: entry?.artifactType || '',
      installedAt: entry?.installedAt || '',
      lastUpdatedAt: entry?.lastUpdatedAt || '',
      managePath: entry?.managePath || '',
    }))
    .sort((a, b) => {
      const left = a.lastUpdatedAt || a.installedAt || '';
      const right = b.lastUpdatedAt || b.installedAt || '';
      return left < right ? 1 : left > right ? -1 : a.appId.localeCompare(b.appId);
    });

  return { apps };
}

export function createServer(config, routes, onLog) {
  const basePath = config.instanceName ? '/' + config.instanceName : '';
  const log = onLog || (() => {});

  const server = http.createServer((req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }

    const url = parseUrl(req);
    let path = url.pathname;

    // strip basePath prefix (e.g. /huangcan/api/ping → /api/ping)
    if (basePath && path.startsWith(basePath)) {
      path = path.slice(basePath.length) || '/';
    }

    // delegate /filedeck requests to filedeck express app
    if (filedeckApp && path.startsWith('/filedeck')) {
      // redirect /filedeck to /filedeck/ so relative paths work
      if (path === '/filedeck') {
        const location = basePath + '/filedeck/';
        res.writeHead(301, { Location: location });
        return res.end();
      }
      const forwardedPath = path.slice('/filedeck'.length) || '/';
      req.url = `${forwardedPath}${url.search || ''}`;
      return filedeckApp(req, res);
    }

    // /hub-puller/*: external entry to the local puller process. Used by
    // GitHub webhooks (POST raw body for HMAC) and by other monitor hosts'
    // hub frontends (which fetch via this same public URL). Path is stripped
    // of the /hub-puller prefix before forwarding so puller's routes are
    // plain /api/*. http.request keeps body streaming intact in both
    // directions — needed for raw-body HMAC verification and Range downloads.
    if (path.startsWith('/hub-puller')) {
      const forwardedPath = path.slice('/hub-puller'.length) || '/';
      const upstream = http.request(
        {
          host: '100.76.197.26',
          port: 8126,
          method: req.method,
          path: `${forwardedPath}${url.search || ''}`,
          headers: { ...req.headers, host: '100.76.197.26:8126' },
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        }
      );
      upstream.on('error', (err) => {
        log('warn', `[hub-puller] proxy error: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: `puller unreachable: ${err.message}` }));
      });
      req.pipe(upstream);
      return;
    }

    // /hub: pure-frontend bundle in services/hub/public, with /hub/api/*
    // reverse-proxied to claw-hub-puller. /hub/api/meta is synthesized
    // locally because it reflects this monitor instance, not the puller.
    if (path.startsWith('/hub')) {
      if (path === '/hub') {
        res.writeHead(301, { Location: basePath + '/hub/' });
        return res.end();
      }
      const subPath = path.slice('/hub'.length); // '' | '/' | '/api/...' | '/index.html' | ...

      if (subPath === '/api/meta') {
        return sendJson(res, {
          instanceName: config.instanceName || '',
          title: 'BFE Hub',
          uploadsEnabled: false,
        });
      }

      if (subPath === '/api/installed-apps') {
        readInstalledApps()
          .then((data) => sendJson(res, data))
          .catch((err) => {
            log('warn', `[hub] installed-apps error: ${err.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          });
        return;
      }

      if (subPath.startsWith('/api/')) {
        proxyHubApiToPuller(req, res, subPath, url.search || '').catch((err) => {
          log('warn', `[hub] proxy error: ${err.message}`);
          if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
        return;
      }

      const rel = subPath === '' || subPath === '/' ? 'index.html' : subPath.replace(/^\//, '');
      return serveFromDir(HUB_PUBLIC_DIR, rel, res);
    }

    // /applications routes:
    //   /applications/                          → public/index.html (grid)
    //   /applications/<top-level-file>          → public/<file> (styles.css, app.js)
    //   /applications/<id>                      → 301 to /applications/<id>/
    //   /applications/<id>/                     → <id>/index.html (the app itself)
    //   /applications/<id>/<sub>                → <id>/<sub> (the app's static files)
    if (req.method === 'GET' && path.startsWith('/applications') && !path.startsWith('/api/')) {
      if (path === '/applications') {
        res.writeHead(301, { Location: basePath + '/applications/' });
        return res.end();
      }
      const rel = path.slice('/applications/'.length);
      if (!rel) return serveFromDir(APPLICATIONS_PUBLIC_DIR, 'index.html', res);

      // top-level static (styles.css, app.js)
      const publicFilePath = join(APPLICATIONS_PUBLIC_DIR, rel);
      if (publicFilePath.startsWith(APPLICATIONS_PUBLIC_DIR) && existsSync(publicFilePath) && statSync(publicFilePath).isFile()) {
        return serveFromDir(APPLICATIONS_PUBLIC_DIR, rel, res);
      }

      // treat as per-app folder: first segment is the app id
      const slashIdx = rel.indexOf('/');
      const appId = slashIdx === -1 ? rel : rel.slice(0, slashIdx);
      const subPath = slashIdx === -1 ? '' : rel.slice(slashIdx + 1);

      // guard: app id must be a safe folder name (hex id in our scheme)
      if (!/^[A-Za-z0-9_-]+$/.test(appId)) return send404(res);

      const appDir = join(APPLICATIONS_STORE_DIR, appId);
      if (!existsSync(appDir) || !statSync(appDir).isDirectory()) return send404(res);

      // /applications/<id> (no trailing slash) → redirect so relative paths resolve under the folder
      if (slashIdx === -1) {
        res.writeHead(301, { Location: basePath + '/applications/' + appId + '/' });
        return res.end();
      }

      // /applications/<id>/progress → 美化 HTML 进度页（不是物理文件）
      // 创建中自动 meta refresh，完成后展示"打开应用"链接
      if (subPath === 'progress') {
        const html = renderProgressPage(appId);
        if (!html) return send404(res);
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': Buffer.byteLength(html),
          'Cache-Control': 'no-store',
        });
        return res.end(html);
      }

      const target = subPath || 'index.html';
      return serveFromDir(appDir, target, res, { noCache: true });
    }

    const key = `${req.method} ${path}`;
    log('info', `${req.method} ${url.pathname} → ${path}`);

    // exact match
    if (routes.has(key)) {
      return routes.get(key)(req, res, url);
    }

    // prefix match for static files
    if (req.method === 'GET' && path.startsWith('/static/')) {
      return serveStatic(config, path, res);
    }

    log('warn', `404 ${req.method} ${path}`);
    send404(res);
  });

  return server;
}

function serveStatic(config, urlPath, res) {
  const staticDir = config.deploy?.staticDir;
  if (!staticDir) return send404(res);

  const rel = urlPath.replace(/^\/static\//, '');
  return serveFromDir(staticDir, rel, res);
}

function serveFromDir(baseDir, rel, res, { noCache = false } = {}) {
  const filePath = join(baseDir, rel);

  // prevent directory traversal
  if (!filePath.startsWith(baseDir)) return send404(res);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return send404(res);

  const ext = extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const body = readFileSync(filePath);
  // HTML always revalidates; user-app files opt into no-cache so edits show immediately.
  const cacheControl = noCache || ext === '.html'
    ? 'no-cache, no-store, must-revalidate'
    : 'public, max-age=3600';
  const headers = {
    'Content-Type': mime,
    'Content-Length': body.length,
    'Cache-Control': cacheControl,
  };
  if (noCache || ext === '.html') {
    headers['Pragma'] = 'no-cache';
    headers['Expires'] = '0';
  }
  res.writeHead(200, headers);
  res.end(body);
}
