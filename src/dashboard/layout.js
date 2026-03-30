export function pageShell(instanceName, bodyHtml) {
  const basePath = instanceName ? '/' + instanceName : '';
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${instanceName} - Claw Monitor v2</title>
  <style>${CSS}</style>
</head>
<body>
  <header class="topbar">
    <h1>${instanceName}</h1>
    <span class="version">Claw Monitor v2</span>
  </header>
  <main class="app">${bodyHtml}</main>
  <script>const BASE='${basePath}';${JS}</script>
</body>
</html>`;
}

const CSS = `
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#0d1117; color:#c9d1d9; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; font-size:14px; }
.topbar { display:flex; align-items:center; justify-content:space-between; padding:12px 20px; background:#161b22; border-bottom:1px solid #30363d; }
.topbar h1 { font-size:18px; color:#58a6ff; }
.version { font-size:12px; color:#8b949e; }
.app { padding:16px; display:grid; grid-template-columns:repeat(auto-fit,minmax(360px,1fr)); gap:16px; }

.panel { background:#161b22; border:1px solid #30363d; border-radius:8px; padding:16px; }
.panel-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
.panel-header h3 { font-size:15px; color:#c9d1d9; }
.panel-cards { display:flex; gap:12px; flex-wrap:wrap; }

.panel-card { flex:1; min-width:120px; padding:12px; border-radius:6px; background:#0d1117; text-align:center; }
.panel-card.ok { border-left:3px solid #3fb950; }
.panel-card.fail { border-left:3px solid #f85149; }
.panel-card.warn { border-left:3px solid #d29922; }
.panel-card.unknown { border-left:3px solid #8b949e; }
.card-title { font-size:12px; color:#8b949e; margin-bottom:4px; }
.card-value { font-size:20px; font-weight:600; }
.card-value.error { color:#f85149; font-size:13px; }
.card-time { font-size:11px; color:#484f58; margin-top:6px; }

.status-badge { padding:2px 8px; border-radius:12px; font-size:12px; font-weight:500; }
.status-badge.ok { background:#238636; color:#fff; }
.status-badge.fail { background:#da3633; color:#fff; }
.status-badge.warn { background:#9e6a03; color:#fff; }
.status-badge.unknown { background:#484f58; color:#ccc; }

.health-bars { display:flex; gap:2px; flex-wrap:wrap; align-items:flex-end; min-height:28px; }
.health-bar { width:6px; height:24px; border-radius:2px; }
.health-bar.ok { background:#3fb950; }
.health-bar.fail { background:#f85149; }
.no-data { color:#484f58; font-size:13px; }
.down-info { color:#f85149; font-size:13px; margin-top:8px; }

.btn { border:1px solid #30363d; background:#21262d; color:#c9d1d9; padding:4px 12px; border-radius:6px; cursor:pointer; font-size:12px; }
.btn:hover { background:#30363d; }
.btn-sm { padding:2px 8px; }

.usage-row { display:flex; align-items:center; gap:8px; margin:6px 0; }
.usage-label { font-size:12px; color:#8b949e; min-width:80px; }
.progress-bar { flex:1; height:8px; background:#21262d; border-radius:4px; overflow:hidden; }
.progress-fill { height:100%; background:#3fb950; border-radius:4px; transition:width 0.3s; }
.progress-fill.warn { background:#d29922; }
.usage-pct { font-size:12px; color:#8b949e; min-width:36px; text-align:right; }

.raw-json { font-size:11px; color:#8b949e; overflow:auto; max-height:120px; white-space:pre-wrap; word-break:break-all; }

.log-table-wrap { max-height:320px; overflow-y:auto; }
.log-table { width:100%; border-collapse:collapse; font-size:12px; }
.log-table th { text-align:left; color:#8b949e; padding:4px 8px; border-bottom:1px solid #21262d; position:sticky; top:0; background:#161b22; }
.log-table td { padding:3px 8px; border-bottom:1px solid #0d1117; vertical-align:top; }
.log-time { white-space:nowrap; color:#8b949e; width:70px; }
.log-source { color:#58a6ff; width:60px; }
.log-level { font-weight:500; width:40px; }
.log-line { word-break:break-all; }
.log-msg { word-break:break-all; }
.log-count { font-size:12px; color:#8b949e; }

.deploy-panel .deploy-url { color:#58a6ff; word-break:break-all; font-size:13px; }
.deploy-panel .deploy-list { list-style:none; max-height:200px; overflow-y:auto; }
.deploy-panel .deploy-list li { padding:4px 0; border-bottom:1px solid #21262d; font-size:12px; }

@media(max-width:480px) {
  .app { grid-template-columns:1fr; padding:8px; }
  .panel-cards { flex-direction:column; }
}
`;

const JS = `
async function triggerPing() {
  try {
    await fetch(BASE+'/api/ping/trigger');
  } catch(e) { console.error(e); }
}
async function refreshCodex() {
  try {
    await fetch(BASE+'/api/codex-usage/refresh');
  } catch(e) { console.error(e); }
}
setInterval(async () => {
  try {
    const r = await fetch(BASE+'/api/html');
    if (r.ok) {
      const html = await r.text();
      document.querySelector('.app').innerHTML = html;
    }
  } catch {}
}, 3000);
`;
