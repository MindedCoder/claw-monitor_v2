import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { SessionStore } from './session.js';
import { resolveTenant } from './tenant.js';
import { connectDb, closeDb, getDb } from './db.js';

const COOKIE_NAME = 'claw_session';

function renderStorageTestPage() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Storage Test</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;background:#0d1117;color:#c9d1d9;padding:16px;font-size:14px;line-height:1.6;margin:0}
h2{font-size:16px;margin:0 0 12px;color:#58a6ff}
.row{background:#161b22;border:1px solid #30363d;border-radius:6px;padding:10px 12px;margin-bottom:8px;word-break:break-all}
.k{color:#8b949e;font-size:12px}
.v{color:#c9d1d9;margin-top:2px}
.ok{color:#3fb950}
.bad{color:#f85149}
.ua{font-size:11px;color:#6e7681;margin-top:2px}
button{background:#238636;color:#fff;border:0;border-radius:6px;padding:10px 16px;font-size:14px;margin:4px 4px 4px 0;cursor:pointer}
button.gray{background:#30363d}
.note{font-size:12px;color:#8b949e;margin-top:12px;padding:10px;background:#161b22;border-radius:6px;border-left:3px solid #58a6ff}
</style></head><body>
<h2>=== Storage Test ===</h2>
<div class="row"><div class="k">当前时间</div><div class="v" id="now"></div></div>
<div class="row"><div class="k">UA</div><div class="ua" id="ua"></div></div>

<div class="row"><div class="k">[Cookie]   storage_test_cookie</div><div class="v" id="ck"></div></div>
<div class="row"><div class="k">[Local]    storage_test_local</div><div class="v" id="ls"></div></div>
<div class="row"><div class="k">[Session]  storage_test_session</div><div class="v" id="ss"></div></div>

<button onclick="writeAll()">重新写入全部</button>
<button class="gray" onclick="clearAll()">清空全部</button>
<button class="gray" onclick="location.reload()">刷新</button>

<div class="note">
说明：<br>
1. 第一次访问 → 点"重新写入全部"，然后截图<br>
2. "被踢"或过段时间后再访问 → 直接截图（不要点任何按钮）<br>
3. 对比两次截图，看谁还在、谁丢了<br>
Cookie Max-Age=7 天；localStorage 关页面不丢；sessionStorage 关标签即丢
</div>

<script>
function fmt(ts){if(!ts)return '';const d=new Date(+ts);return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')+':'+String(d.getSeconds()).padStart(2,'0')}
function ago(ts){if(!ts)return '';const s=Math.floor((Date.now()-+ts)/1000);if(s<60)return s+'秒前';if(s<3600)return Math.floor(s/60)+'分钟前';if(s<86400)return Math.floor(s/3600)+'小时前';return Math.floor(s/86400)+'天前'}
function getCookie(name){const m=document.cookie.match(new RegExp('(?:^|; )'+name+'=([^;]*)'));return m?decodeURIComponent(m[1]):''}
function show(id,val){const el=document.getElementById(id);if(val){el.innerHTML='<span class="ok">✓ '+fmt(val)+'</span> <span class="k">('+ago(val)+'写入)</span>'}else{el.innerHTML='<span class="bad">✗ 已丢失/未写入</span>'}}
function refresh(){
  document.getElementById('now').textContent=fmt(Date.now());
  document.getElementById('ua').textContent=navigator.userAgent;
  show('ck',getCookie('storage_test_cookie'));
  try{show('ls',localStorage.getItem('storage_test_local'))}catch(e){document.getElementById('ls').innerHTML='<span class="bad">无法访问 localStorage</span>'}
  try{show('ss',sessionStorage.getItem('storage_test_session'))}catch(e){document.getElementById('ss').innerHTML='<span class="bad">无法访问 sessionStorage</span>'}
}
function writeAll(){
  const ts=String(Date.now());
  document.cookie='storage_test_cookie='+ts+'; Path=/; Max-Age='+(7*24*3600)+'; SameSite=Lax';
  try{localStorage.setItem('storage_test_local',ts)}catch(e){}
  try{sessionStorage.setItem('storage_test_session',ts)}catch(e){}
  refresh();
}
function clearAll(){
  document.cookie='storage_test_cookie=; Path=/; Max-Age=0';
  try{localStorage.removeItem('storage_test_local')}catch(e){}
  try{sessionStorage.removeItem('storage_test_session')}catch(e){}
  refresh();
}
refresh();
</script>
</body></html>`;
}

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

  function setCookie(res, value, maxAge) {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAge / 1000)}`);
  }

  function clearCookie(res) {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`);
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

      // storage persistence test page (no auth, for debugging WebView storage behavior)
      if (path === '/auth/storage-test') {
        return sendHtml(res, renderStorageTestPage());
      }

      // nginx auth_request check
      if (path === '/auth/check') {
        // Nginx Ingress sends X-Original-URL (full URL) by default
        const originalUrl = req.headers['x-original-url'] || '';
        const originalUri = req.headers['x-original-uri']
          || url.searchParams.get('rd')
          || (originalUrl ? new URL(originalUrl, 'http://localhost').pathname : '')
          || '';
        console.log(`[auth/check] headers: x-original-url=${originalUrl} x-original-uri=${req.headers['x-original-uri'] || ''}`);

        if (originalUri.includes('/api/') || originalUri.includes('/static/') || originalUri.endsWith('/healthz')) {
          res.writeHead(200);
          return res.end();
        }

        const tenant = resolveTenant(originalUri, config);
        const cookies = parseCookies(req);
        const sid = cookies[COOKIE_NAME];
        console.log(`[auth/check] uri=${originalUri} tenant=${tenant.prefix} sid=${sid ? sid.slice(0, 8) + '...' : 'none'}`);

        const sessUser = sid ? await sessions.get(sid) : null;
        if (!sessUser || !sessUser.phone) {
          console.log(`[auth/check] FAIL no valid session`);
          res.writeHead(401);
          return res.end();
        }

        // live tenant check from users collection
        const dbUser = await getDb().collection('users').findOne(
          { phone: sessUser.phone },
          { projection: { tenants: 1, name: 1 } },
        );
        if (!dbUser) {
          console.log(`[auth/check] FAIL user removed: ${sessUser.phone}`);
          res.writeHead(401);
          return res.end();
        }
        if (!Array.isArray(dbUser.tenants) || !dbUser.tenants.includes(tenant.prefix)) {
          console.log(`[auth/check] FAIL user=${dbUser.name} no access to ${tenant.prefix}`);
          res.writeHead(401);
          return res.end();
        }
        console.log(`[auth/check] OK user=${dbUser.name} tenant=${tenant.prefix}`);
        res.writeHead(200, { 'X-Auth-User': encodeURIComponent(dbUser.name || '') });
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

        const sid = await sessions.create(user);
        const cookieStr = `${COOKIE_NAME}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ttl / 1000)}`;
        console.log(`[callback] SUCCESS user=${user.name} sid=${sid.slice(0, 8)}... rd=${rdParam}`);
        res.writeHead(302, {
          Location: rdParam,
          'Set-Cookie': cookieStr,
        });
        return res.end();
      }

      // logout
      if (path === '/auth/logout') {
        const cookies = parseCookies(req);
        const sid = cookies[COOKIE_NAME];
        if (sid) await sessions.destroy(sid);
        res.writeHead(302, {
          Location: '/',
          'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; Max-Age=0`,
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
