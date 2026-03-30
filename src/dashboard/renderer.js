import { pageShell } from './layout.js';

export function renderFull(config, panels) {
  const inner = renderInner(panels);
  return pageShell(config.instanceName || 'Claw Monitor', inner);
}

export function renderInner(panels) {
  return panels.map(p => {
    try { return p.render(); } catch { return ''; }
  }).join('');
}
