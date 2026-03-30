export default {
  renderLoginPage({ state, rd, config }) {
    const title = config.title || 'Login';
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
body{background:#0d1117;color:#c9d1d9;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:32px;width:320px}
h2{margin-bottom:16px;color:#58a6ff}
input{width:100%;padding:8px;margin:8px 0;background:#0d1117;border:1px solid #30363d;color:#c9d1d9;border-radius:4px}
button{width:100%;padding:10px;background:#238636;border:none;color:#fff;border-radius:4px;cursor:pointer;margin-top:8px}
button:hover{background:#2ea043}
.err{color:#f85149;font-size:13px;margin-top:8px}
</style></head>
<body><div class="box">
<h2>${title}</h2>
<form method="POST" action="/auth/callback">
<input type="hidden" name="state" value="${state}">
<input type="hidden" name="rd" value="${rd}">
<input type="password" name="password" placeholder="密码" required autofocus>
<button type="submit">登录</button>
</form>
</div></body></html>`;
  },

  async getUser({ body, config }) {
    const expected = config.password;
    if (!expected) return null;
    if (body.password !== expected) return null;
    return { name: config.username || 'admin', provider: 'password' };
  },
};
