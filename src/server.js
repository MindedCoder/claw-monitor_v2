import http from 'node:http';
import { createRequire } from 'node:module';
import { parseUrl, sendJson, sendHtml, send404, sendText } from './lib/http-helpers.js';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const APPLICATIONS_PUBLIC_DIR = join(__dirname, '..', 'services', 'applications', 'public');
const APPLICATIONS_STORE_DIR = join(__dirname, '..', 'services', 'applications');

let filedeckApp;
try {
  filedeckApp = require('../services/filedeck/server.js');
} catch {
  // filedeck not available, skip
}

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};

export function createServer(config, routes, onLog) {
  const basePath = config.instanceName ? '/' + config.instanceName : '';
  const log = onLog || (() => {});

  const server = http.createServer((req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

      const target = subPath || 'index.html';
      return serveFromDir(appDir, target, res);
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

function serveFromDir(baseDir, rel, res) {
  const filePath = join(baseDir, rel);

  // prevent directory traversal
  if (!filePath.startsWith(baseDir)) return send404(res);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return send404(res);

  const ext = extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const body = readFileSync(filePath);
  // HTML must revalidate so that versioned asset URLs (?v=N) flow through
  const cacheControl = ext === '.html' ? 'no-cache, must-revalidate' : 'public, max-age=3600';
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': body.length,
    'Cache-Control': cacheControl,
  });
  res.end(body);
}
