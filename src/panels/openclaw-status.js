import { sendJson } from '../lib/http-helpers.js';
import { relative } from '../lib/html.js';

export default function createOpenClawStatusPanel(config) {
  const cfg = config.health || {};
  const url = cfg.url || 'http://127.0.0.1:18789/health';
  const intervalMs = cfg.intervalMs || 5000;
  const timeoutMs = cfg.timeoutMs || 5000;

  const state = {
    status: 'unknown',   // unknown | offline | idle | thinking | answering
    detail: null,        // raw response from endpoint
    lastCheck: null,
    lastOnline: null,
    error: null,
  };

  let timer = null;

  async function check() {
    const ts = Date.now();
    state.lastCheck = ts;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);

      if (!res.ok) {
        state.status = 'offline';
        state.error = `HTTP ${res.status}`;
        state.detail = null;
        return;
      }

      state.lastOnline = ts;
      state.error = null;

      const contentType = res.headers.get('content-type') || '';
      if (contentType.includes('json')) {
        const data = await res.json();
        state.detail = data;
        // try to extract status from response
        if (data.status) {
          const s = String(data.status).toLowerCase();
          if (s.includes('think')) state.status = 'thinking';
          else if (s.includes('answer') || s.includes('respond') || s.includes('generat')) state.status = 'answering';
          else if (s.includes('idle') || s.includes('ready') || s.includes('ok') || s.includes('healthy')) state.status = 'idle';
          else state.status = 'idle'; // online but unknown sub-state → idle
        } else {
          state.status = 'idle';
        }
      } else {
        state.detail = null;
        state.status = 'idle';
      }
    } catch (err) {
      state.status = 'offline';
      state.error = err.name === 'AbortError' ? '超时' : err.message;
      state.detail = null;
    }
  }

  function startPolling() {
    check();
    timer = setInterval(check, intervalMs);
  }

  function stopPolling() {
    if (timer) clearInterval(timer);
  }

  function getStatus() {
    return { ...state, detail: undefined };
  }

  function routes() {
    return {
      'GET /api/openclaw-status': (req, res) => sendJson(res, { ...state }),
      'GET /api/openclaw-status/check': async (req, res) => {
        await check();
        sendJson(res, { ...state });
      },
    };
  }

  function render() {
    const statusConfig = {
      unknown:   { label: '未知',   icon: '?',  cls: 'unknown', anim: '' },
      offline:   { label: '离线',   icon: '!',  cls: 'fail',    anim: '' },
      idle:      { label: '休息中', icon: '~',  cls: 'ok',      anim: '' },
      thinking:  { label: '思考中', icon: '*',  cls: 'warn',    anim: 'pulse' },
      answering: { label: '回答中', icon: '>',  cls: 'ok',      anim: 'pulse' },
    };

    const sc = statusConfig[state.status] || statusConfig.unknown;

    const detailRows = [];
    if (state.detail && typeof state.detail === 'object') {
      for (const [k, v] of Object.entries(state.detail)) {
        if (k === 'status') continue;
        detailRows.push(`<div class="claw-detail-row"><span class="claw-detail-key">${k}</span><span class="claw-detail-val">${String(v)}</span></div>`);
      }
    }

    const errorHtml = state.error
      ? `<div class="claw-error">错误: ${state.error}</div>`
      : '';

    return `
      <div class="panel claw-status-panel">
        <div class="panel-header">
          <h3>OpenClaw 实时状态</h3>
          <span class="status-badge ${sc.cls}">${sc.label}</span>
        </div>
        <div class="claw-status-display">
          <div class="claw-status-icon ${sc.cls} ${sc.anim}">${sc.icon}</div>
          <div class="claw-status-label">${sc.label}</div>
        </div>
        ${errorHtml}
        ${detailRows.length ? `<div class="claw-details">${detailRows.join('')}</div>` : ''}
        <div class="card-time">上次检测: ${state.lastCheck ? relative(state.lastCheck) : '-'}</div>
      </div>`;
  }

  return { name: 'openclaw-status', routes, render, startPolling, stopPolling, getStatus, check };
}
