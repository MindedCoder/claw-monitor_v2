export function pageShell(instanceName, bodyHtml, showAll = false, displayName) {
  const basePath = instanceName ? '/' + instanceName : '';
  const showParam = showAll ? '?show=all' : '';
  const title = displayName || instanceName;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} - Claw Console</title>
  <style>${CSS}</style>
</head>
<body>
  <header class="topbar">
    <h1>${title}</h1>
    <span class="version">Claw Console</span>
  </header>
  <main class="app">${bodyHtml}</main>
  <script>const BASE='${basePath}';const SHOW_PARAM='${showParam}';${JS}</script>
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

.claw-status-panel { grid-column: 1 / -1; }
.claw-status-display { display:flex; align-items:center; gap:16px; padding:16px 0; }
.claw-status-icon { width:48px; height:48px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:24px; font-weight:700; color:#fff; }
.claw-status-icon.ok { background:#238636; }
.claw-status-icon.fail { background:#da3633; }
.claw-status-icon.warn { background:#9e6a03; }
.claw-status-icon.unknown { background:#484f58; }
.claw-status-icon.pulse { animation:pulse 1.5s ease-in-out infinite; }
@keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.7;transform:scale(1.08)} }
.claw-status-label { font-size:22px; font-weight:600; color:#c9d1d9; }
.claw-error { color:#f85149; font-size:13px; margin:8px 0; }
.claw-details { margin:8px 0; }
.claw-detail-row { display:flex; gap:8px; font-size:12px; padding:2px 0; }
.claw-detail-key { color:#8b949e; min-width:80px; }
.claw-detail-val { color:#c9d1d9; }
.feishu-subrow td { padding-top:0; }
.feishu-name-cell { max-width:90px; width:90px; }
.feishu-name { font-weight:600; color:#c9d1d9; max-width:90px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.feishu-table .status-badge { white-space:nowrap; }
.feishu-key { font-size:11px; color:#8b949e; margin-top:2px; word-break:break-all; }
.feishu-line { font-size:12px; color:#8b949e; padding:2px 0; }
.feishu-k { display:inline-block; min-width:64px; color:#8b949e; }
.feishu-v { color:#c9d1d9; }
.feishu-detail { color:#c9d1d9; }
.feishu-hint { margin-top:8px; font-size:12px; color:#8b949e; line-height:1.5; }

@media(max-width:480px) {
  .app { grid-template-columns:1fr; padding:8px; }
  .panel-cards { flex-direction:column; }
  .claw-status-panel { grid-column: 1; }
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
let logHover = false;
document.addEventListener('mouseover', e => {
  logHover = !!e.target.closest && !!e.target.closest('.log-table-wrap');
});
document.addEventListener('mouseout', e => {
  if (e.target.closest && e.target.closest('.log-table-wrap')) logHover = false;
});
function hasLogSelection() {
  const sel = window.getSelection && window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  const node = sel.anchorNode;
  if (!node) return false;
  const el = node.nodeType === 1 ? node : node.parentElement;
  return !!(el && el.closest && el.closest('.log-table-wrap'));
}
setInterval(async () => {
  if (logHover || hasLogSelection()) return;
  try {
    const scrolls = {};
    document.querySelectorAll('.panel').forEach(p => {
      const wrap = p.querySelector('.log-table-wrap');
      if (wrap) scrolls[p.className] = wrap.scrollTop;
    });
    const r = await fetch(BASE+'/api/html'+SHOW_PARAM);
    if (r.ok) {
      const html = await r.text();
      document.querySelector('.app').innerHTML = html;
      document.querySelectorAll('.panel').forEach(p => {
        const wrap = p.querySelector('.log-table-wrap');
        if (wrap && scrolls[p.className] != null) wrap.scrollTop = scrolls[p.className];
      });
    }
  } catch {}
}, 3000);
`;
