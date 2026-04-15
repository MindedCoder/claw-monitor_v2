import { pageShell } from './layout.js';

const HIDDEN_PANELS = new Set(['deploy', 'system-log', 'frpc', 'logs', 'feishu-status']);

export function renderFull(config, panels, showAll = false) {
  const inner = renderInner(panels, showAll);
  const instanceName = config.instanceName || 'Claw Monitor';
  const displayName = config.displayName || instanceName;
  return pageShell(instanceName, inner, showAll, displayName);
}

export function renderInner(panels, showAll = false) {
  return panels.filter(p => showAll || !HIDDEN_PANELS.has(p.name)).map(p => {
    try { return p.render(); } catch { return ''; }
  }).join('');
}
