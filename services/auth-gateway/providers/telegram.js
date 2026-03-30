import { createHmac, createHash } from 'node:crypto';

export default {
  renderLoginPage({ state, rd, config }) {
    const botName = config.botName;
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Telegram Login</title>
<style>
body{background:#0d1117;color:#c9d1d9;font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
.box{text-align:center}
</style></head>
<body><div class="box">
<script async src="https://telegram.org/js/telegram-widget.js?22"
  data-telegram-login="${botName}"
  data-size="large"
  data-auth-url="/auth/callback?state=${state}&rd=${encodeURIComponent(rd)}"
  data-request-access="write"></script>
</div></body></html>`;
  },

  async getUser({ query, config }) {
    const { hash, ...data } = query;
    if (!hash) return null;

    // verify telegram hash
    const secret = createHash('sha256').update(config.botToken).digest();
    const checkStr = Object.keys(data).sort().map(k => `${k}=${data[k]}`).join('\n');
    const hmac = createHmac('sha256', secret).update(checkStr).digest('hex');

    if (hmac !== hash) return null;

    // check auth_date not too old (1 hour)
    const authDate = parseInt(data.auth_date, 10);
    if (Date.now() / 1000 - authDate > 3600) return null;

    return {
      name: [data.first_name, data.last_name].filter(Boolean).join(' '),
      telegramId: data.id,
      username: data.username,
      avatar: data.photo_url,
      provider: 'telegram',
    };
  },
};
