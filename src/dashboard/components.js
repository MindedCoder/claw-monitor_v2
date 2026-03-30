import { esc } from '../lib/html.js';

export function statBox(label, value, colorClass = '') {
  return `
    <div class="panel-card ${colorClass}">
      <div class="card-title">${esc(label)}</div>
      <div class="card-value">${esc(String(value))}</div>
    </div>`;
}

export function card(title, badge, content) {
  const badgeHtml = badge ? `<span class="status-badge ${badge.cls || ''}">${esc(badge.text)}</span>` : '';
  return `
    <div class="panel">
      <div class="panel-header">
        <h3>${esc(title)}</h3>
        ${badgeHtml}
      </div>
      ${content}
    </div>`;
}

export function progressBar(pct, warn = false) {
  return `
    <div class="progress-bar">
      <div class="progress-fill ${warn ? 'warn' : ''}" style="width:${Math.min(100, pct)}%"></div>
    </div>`;
}
