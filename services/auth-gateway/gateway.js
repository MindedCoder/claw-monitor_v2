import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { SessionStore } from './session.js';
import { resolveTenant } from './tenant.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// load providers dynamically
const providers = {};
async function loadProvider(name) {
  if (providers[name]) return providers[name];
  const mod = await import(`./providers/${name}.js`);
  providers[name] = mod.default;
  return providers[name];
}

export async function startGateway(config) {
  const port = config.port || 4180;
  const cookieName = config.cookieName || 'claw_session';
  const ttl = config.sessionTtlMs || 7 * 24 * 3600 * 1000;
  const sessions = new SessionStore(ttl);

  function parseCookies(req) {
    const map = {};
    for (const pair of (req.headers.cookie || '').split(';')) {
      const [k, ...v] = pair.trim().split('=');
      if (k) map[k] = decodeURIComponent(v.join('='));
    }
    return map;
  }

  function parseForm(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        const params = new URLSearchParams(text);
        resolve(Object.fromEntries(params));
      });
    });
  }

  function parseQuery(req) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    return Object.fromEntries(url.searchParams);
  }

  function setCookie(res, value, maxAge) {
    res.setHeader('Set-Cookie', `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAge / 1000)}`);
  }

  function clearCookie(res) {
    res.setHeader('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; Max-Age=0`);
  }

  function redirect(res, url) {
    res.writeHead(302, { Location: url });
    res.end();
  }

  function sendHtml(res, html, status = 200) {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;

    try {
      // health check
      if (path === '/healthz') {
        res.writeHead(200);
        return res.end('ok');
      }

      // nginx auth_request check
      if (path === '/auth/check') {
        const cookies = parseCookies(req);
        const sid = cookies[cookieName];
        const user = sid ? sessions.get(sid) : null;
        if (user) {
          res.writeHead(200, { 'X-Auth-User': user.name || '' });
        } else {
          res.writeHead(401);
        }
        return res.end();
      }

      // resolve tenant from original request path or rd param
      const rd = url.searchParams.get('rd') || req.headers['x-original-uri'] || '/';
      const tenant = resolveTenant(rd, config);
      const provider = await loadProvider(tenant.authProvider);

      // login page
      if (path === '/auth/login') {
        const state = randomBytes(16).toString('hex');
        if (provider.getAuthUrl) {
          const callbackUrl = `${url.protocol}//${url.host}/auth/callback`;
          const authUrl = provider.getAuthUrl({ redirectUri: callbackUrl, state, config: tenant.provider });
          return redirect(res, authUrl);
        }
        if (provider.renderLoginPage) {
          const html = provider.renderLoginPage({ state, rd, config: tenant.provider });
          return sendHtml(res, html);
        }
        res.writeHead(500);
        return res.end('No login method available');
      }

      // callback (OAuth or form POST)
      if (path === '/auth/callback') {
        let user = null;

        if (req.method === 'POST') {
          const body = await parseForm(req);
          user = await provider.getUser({ body, config: tenant.provider });
        } else {
          const code = url.searchParams.get('code');
          const query = parseQuery(req);
          if (code) {
            const callbackUrl = `${url.protocol}//${url.host}/auth/callback`;
            user = await provider.getUser({ code, redirectUri: callbackUrl, config: tenant.provider });
          } else if (provider.getUser) {
            user = await provider.getUser({ query, config: tenant.provider });
          }
        }

        if (!user) {
          return sendHtml(res, '<h3>认证失败</h3><a href="/auth/login">重试</a>', 403);
        }

        const sid = sessions.create(user);
        setCookie(res, sid, ttl);

        const rdParam = url.searchParams.get('rd') || '/';
        return redirect(res, rdParam);
      }

      // logout
      if (path === '/auth/logout') {
        const cookies = parseCookies(req);
        const sid = cookies[cookieName];
        if (sid) sessions.destroy(sid);
        clearCookie(res);
        return redirect(res, '/');
      }

      res.writeHead(404);
      res.end('not found');
    } catch (err) {
      console.error('[auth-gateway]', err);
      res.writeHead(500);
      res.end('internal error');
    }
  });

  server.listen(port, () => {
    console.log(`[auth-gateway] listening on :${port}`);
  });

  return { server, sessions };
}

// standalone mode
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const confPath = process.argv[2] || resolve(__dirname, '../../data/config.json');
  let gwConfig;
  if (existsSync(confPath)) {
    const full = JSON.parse(readFileSync(confPath, 'utf-8'));
    gwConfig = full.authGateway || full;
  } else {
    gwConfig = { port: 4180, authProvider: 'password', provider: { password: 'changeme' } };
  }
  startGateway(gwConfig);
}
