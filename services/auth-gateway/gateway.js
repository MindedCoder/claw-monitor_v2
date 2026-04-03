import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { SessionStore } from './session.js';
import { resolveTenant, getTenantSlug } from './tenant.js';
import { connectDb, closeDb } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// load login.html template once
const loginTemplate = readFileSync(resolve(__dirname, 'login.html'), 'utf-8');

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
  const ttl = config.sessionTtlMs || 7 * 24 * 3600 * 1000;

  // connect to MongoDB
  await connectDb(config);
  const sessions = new SessionStore(ttl);

  function parseCookies(req) {
    const map = {};
    for (const pair of (req.headers.cookie || '').split(';')) {
      const [k, ...v] = pair.trim().split('=');
      if (k) map[k] = decodeURIComponent(v.join('='));
    }
    return map;
  }

  function readJson(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch {
          resolve({});
        }
      });
    });
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

  function cookieName(tenantPrefix) {
    return `claw_session_${getTenantSlug(tenantPrefix)}`;
  }

  function setCookie(res, tenantPrefix, value, maxAge) {
    const name = cookieName(tenantPrefix);
    res.setHeader('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAge / 1000)}`);
  }

  function clearCookie(res, tenantPrefix) {
    const name = cookieName(tenantPrefix);
    res.setHeader('Set-Cookie', `${name}=; Path=/; HttpOnly; Max-Age=0`);
  }

  function redirect(res, url) {
    res.writeHead(302, { Location: url });
    res.end();
  }

  function sendHtml(res, html, status = 200) {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  function sendJson(res, data, status = 200) {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
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
        const originalUri = req.headers['x-original-uri'] || '';
        if (originalUri.includes('/api/') || originalUri.includes('/static/') || originalUri.endsWith('/healthz')) {
          res.writeHead(200);
          return res.end();
        }

        const tenant = resolveTenant(originalUri, config);
        const cookies = parseCookies(req);
        const cName = cookieName(tenant.prefix);
        const sid = cookies[cName];
        console.log(`[auth/check] uri=${originalUri} tenant=${tenant.prefix} cookie=${cName} sid=${sid ? sid.slice(0, 8) + '...' : 'none'}`);
        const user = sid ? await sessions.get(sid, tenant.prefix) : null;
        if (user) {
          console.log(`[auth/check] OK user=${user.name}`);
          res.writeHead(200, { 'X-Auth-User': user.name || '' });
        } else {
          console.log(`[auth/check] FAIL no valid session`);
          res.writeHead(401);
        }
        return res.end();
      }

      // resolve tenant from rd param or original uri
      const rd = url.searchParams.get('rd') || req.headers['x-original-uri'] || '/';
      const tenant = resolveTenant(rd, config);
      const provider = await loadProvider(tenant.authProvider);

      // send verification code (phone provider)
      if (path === '/auth/send-code' && req.method === 'POST') {
        const body = await readJson(req);
        const phone = body.phone;
        const tenantPrefix = body.tenant || tenant.prefix;

        if (!phone) return sendJson(res, { message: '请输入手机号' }, 400);

        const phoneProvider = await loadProvider('phone');
        const result = await phoneProvider.sendCode({
          phone,
          tenant: tenantPrefix,
          smsConfig: config.sms,
        });

        return sendJson(res, { message: result.message }, result.ok ? 200 : result.status);
      }

      // login page
      if (path === '/auth/login') {
        const state = randomBytes(16).toString('hex');
        if (provider.getAuthUrl) {
          const callbackUrl = `${url.protocol}//${url.host}/auth/callback`;
          const authUrl = provider.getAuthUrl({ redirectUri: callbackUrl, state, config: tenant.provider });
          return redirect(res, authUrl);
        }
        // phone provider — serve static login page
        if (tenant.authProvider === 'phone') {
          const html = loginTemplate
            .replace('{{TENANT}}', tenant.prefix)
            .replace('{{RD}}', rd);
          return sendHtml(res, html);
        }
        if (provider.renderLoginPage) {
          const html = provider.renderLoginPage({ state, rd, config: tenant.provider });
          return sendHtml(res, html);
        }
        res.writeHead(500);
        return res.end('No login method available');
      }

      // callback (OAuth, password form, or phone code verification)
      if (path === '/auth/callback') {
        let user = null;
        let rdParam = '/';
        let effectiveTenant = tenant;

        if (req.method === 'POST') {
          const contentType = req.headers['content-type'] || '';
          let body;

          if (contentType.includes('application/json')) {
            body = await readJson(req);
            rdParam = body.rd || '/';
          } else {
            body = await parseForm(req);
            rdParam = body.rd || '/';
          }

          // re-resolve tenant from body (phone provider sends tenant in body)
          if (body.tenant) {
            effectiveTenant = resolveTenant(body.tenant, config);
          }
          const effectiveProvider = await loadProvider(effectiveTenant.authProvider);

          user = await effectiveProvider.getUser({ body, config: effectiveTenant.provider, tenant: effectiveTenant.prefix });
        } else {
          const code = url.searchParams.get('code');
          const query = Object.fromEntries(url.searchParams);
          rdParam = url.searchParams.get('rd') || '/';
          if (code) {
            const callbackUrl = `${url.protocol}//${url.host}/auth/callback`;
            user = await provider.getUser({ code, redirectUri: callbackUrl, config: tenant.provider });
          } else if (provider.getUser) {
            user = await provider.getUser({ query, config: tenant.provider });
          }
        }

        if (!user) {
          if (req.headers['content-type']?.includes('application/json')) {
            return sendJson(res, { message: '验证码错误或已过期' }, 403);
          }
          return sendHtml(res, '<h3>认证失败</h3><a href="/auth/login">重试</a>', 403);
        }

        const sid = await sessions.create(user, effectiveTenant.prefix);
        const cName = cookieName(effectiveTenant.prefix);
        const cookieStr = `${cName}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ttl / 1000)}`;
        console.log(`[callback] SUCCESS user=${user.name} tenant=${effectiveTenant.prefix} cookie=${cName} sid=${sid.slice(0, 8)}... rd=${rdParam}`);
        console.log(`[callback] Set-Cookie: ${cookieStr.slice(0, 60)}...`);
        res.writeHead(302, {
          Location: rdParam,
          'Set-Cookie': cookieStr,
        });
        return res.end();
      }

      // logout
      if (path === '/auth/logout') {
        const cookies = parseCookies(req);
        const cName = cookieName(tenant.prefix);
        const sid = cookies[cName];
        if (sid) await sessions.destroy(sid);
        const cNameLogout = cookieName(tenant.prefix);
        res.writeHead(302, {
          Location: '/',
          'Set-Cookie': `${cNameLogout}=; Path=/; HttpOnly; Max-Age=0`,
        });
        return res.end();
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

  // graceful shutdown
  const shutdown = async () => {
    server.close();
    await closeDb();
  };

  return { server, sessions, shutdown };
}

// standalone mode
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const confPath = process.env.AUTH_CONFIG_PATH || process.argv[2] || resolve(__dirname, '../../data/config.json');
  let gwConfig;
  if (existsSync(confPath)) {
    const full = JSON.parse(readFileSync(confPath, 'utf-8'));
    gwConfig = full.authGateway || full;
  } else {
    gwConfig = { port: 4180, authProvider: 'password', provider: { password: 'changeme' } };
  }

  // env overrides for secrets (from K8s Secret)
  if (process.env.MONGODB_URI) {
    gwConfig.mongodb = gwConfig.mongodb || {};
    gwConfig.mongodb.uri = process.env.MONGODB_URI;
  }
  if (process.env.SMS_ACCESS_KEY_ID) {
    gwConfig.sms = gwConfig.sms || {};
    gwConfig.sms.accessKeyId = process.env.SMS_ACCESS_KEY_ID;
  }
  if (process.env.SMS_ACCESS_KEY_SECRET) {
    gwConfig.sms = gwConfig.sms || {};
    gwConfig.sms.accessKeySecret = process.env.SMS_ACCESS_KEY_SECRET;
  }

  startGateway(gwConfig);
}
