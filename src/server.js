import http from 'node:http';
import { parseUrl, sendJson, sendHtml, send404, sendText } from './lib/http-helpers.js';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

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
  const filePath = join(staticDir, rel);

  // prevent directory traversal
  if (!filePath.startsWith(staticDir)) return send404(res);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return send404(res);

  const ext = extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const body = readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': body.length,
    'Cache-Control': 'public, max-age=3600',
  });
  res.end(body);
}
