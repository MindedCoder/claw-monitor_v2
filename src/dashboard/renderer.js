import { pageShell } from './layout.js';

const HIDDEN_PANELS = new Set(['deploy', 'system-log']);

export function renderFull(config, panels, showAll = false) {
  const inner = renderInner(panels, showAll);
  return pageShell(config.instanceName || 'Claw Monitor', inner, showAll);
}

export function renderInner(panels, showAll = false) {
  return panels.filter(p => showAll || !HIDDEN_PANELS.has(p.name)).map(p => {
    try { return p.render(); } catch { return ''; }
  }).join('');
}
