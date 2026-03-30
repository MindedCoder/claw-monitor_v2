import { readFileSync, existsSync } from 'node:fs';
import { fetchWithTimeout } from '../lib/fetch-utils.js';
import { sendJson } from '../lib/http-helpers.js';
import { esc } from '../lib/html.js';

const USAGE_API = 'https://chatgpt.com/backend-api/wham/usage';

export default function createCodexPanel(config) {
  const cfg = config.codexUsage || {};
  const intervalMs = cfg.intervalMs || 300000;
  const authPath = cfg.authProfilesPath;

  const state = {
    lastCheck: null,
    error: null,
    email: null,
    plan: null,
    limitReached: false,
    primary: null,
    secondary: null,
  };

  let timer = null;

  function readToken() {
    if (!authPath || !existsSync(authPath)) return null;
    try {
      const data = JSON.parse(readFileSync(authPath, 'utf-8'));

      // prefer openai-codex:default.access (OAuth JWT)
      if (data.profiles?.['openai-codex:default']?.access) {
        return data.profiles['openai-codex:default'].access;
      }

      // fallback: iterate all profiles
      if (data.profiles && typeof data.profiles === 'object') {
        for (const p of Object.values(data.profiles)) {
          const token = p.access || p.accessToken || p.key;
          if (token) return token;
        }
      }

      return data.access || data.accessToken || data.key || null;
    } catch { return null; }
  }

  async function refresh() {
    const token = readToken();
    console.log(`[codex-usage] token: ${token ? token.slice(0, 30) + '...' : 'null'} (from ${authPath})`);
    if (!token) {
      state.error = 'token not found';
      state.lastCheck = Date.now();
      return state;
    }

    try {
      console.log(`[codex-usage] requesting ${USAGE_API}`);
      const res = await fetchWithTimeout(USAGE_API, {
        timeoutMs: 15000,
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'OpenClaw-Monitor/2.0',
          'Accept': 'application/json',
        },
      });

      console.log(`[codex-usage] response status: ${res.status}`);
      if (!res.ok) {
        const body = await res.text();
        console.log(`[codex-usage] error body: ${body.slice(0, 500)}`);
        state.error = `HTTP ${res.status}`;
        state.lastCheck = Date.now();
        return state;
      }

      const data = await res.json();
      console.log(`[codex-usage] response: ${JSON.stringify(data).slice(0, 500)}`);
      const rl = data.rate_limit || {};

      state.error = null;
      state.limitReached = rl.limit_reached || false;
      state.email = data.email || null;
      state.plan = data.plan_type || null;
      state.primary = rl.primary_window ? {
        usedPercent: rl.primary_window.used_percent,
        resetAt: new Date(rl.primary_window.reset_at * 1000).toISOString(),
      } : null;
      state.secondary = rl.secondary_window ? {
        usedPercent: rl.secondary_window.used_percent,
        resetAt: new Date(rl.secondary_window.reset_at * 1000).toISOString(),
      } : null;
    } catch (err) {
      console.log(`[codex-usage] error: ${err.message}`);
      state.error = err.message;
    }
    state.lastCheck = Date.now();
    return state;
  }

  function startPolling() {
    if (!cfg.enabled) return;
    refresh();
    timer = setInterval(refresh, intervalMs);
  }

  function stopPolling() {
    if (timer) clearInterval(timer);
  }

  function routes() {
    return {
      'GET /api/codex-usage': (req, res) => sendJson(res, state),
      'GET /api/codex-usage/refresh': async (req, res) => {
        await refresh();
        sendJson(res, state);
      },
    };
  }

  function render() {
    let content;
    if (state.error) {
      content = `<div class="card-value error">${esc(state.error)}</div>`;
    } else if (!state.primary && !state.secondary) {
      content = `<div class="card-value unknown">未获取</div>`;
    } else {
      const rows = [];
      if (state.primary) {
        const pct = Math.round(state.primary.usedPercent);
        const resetTime = new Date(state.primary.resetAt).toLocaleTimeString('zh-CN', { hour12: false });
        rows.push(`
          <div class="usage-row">
            <span class="usage-label">5h 窗口</span>
            <div class="progress-bar">
              <div class="progress-fill ${pct > 80 ? 'warn' : ''}" style="width:${pct}%"></div>
            </div>
            <span class="usage-pct">${pct}%</span>
          </div>
          <div class="card-time">重置: ${resetTime}</div>`);
      }
      if (state.secondary) {
        const pct = Math.round(state.secondary.usedPercent);
        const resetTime = new Date(state.secondary.resetAt).toLocaleTimeString('zh-CN', { hour12: false });
        rows.push(`
          <div class="usage-row">
            <span class="usage-label">周窗口</span>
            <div class="progress-bar">
              <div class="progress-fill ${pct > 80 ? 'warn' : ''}" style="width:${pct}%"></div>
            </div>
            <span class="usage-pct">${pct}%</span>
          </div>
          <div class="card-time">重置: ${resetTime}</div>`);
      }
      content = rows.join('');
      if (state.limitReached) {
        content += `<div class="down-info">已达配额上限</div>`;
      }
    }

    const planInfo = state.plan ? `<span class="log-count">${esc(state.plan)}</span>` : '';

    return `
      <div class="panel codex-panel">
        <div class="panel-header">
          <h3>Codex 使用量</h3>
          ${planInfo}
          <button onclick="refreshCodex()" class="btn btn-sm">刷新</button>
        </div>
        ${content}
        <div class="card-time">更新: ${state.lastCheck ? new Date(state.lastCheck).toLocaleTimeString('zh-CN', { hour12: false }) : '-'}</div>
      </div>`;
  }

  return { name: 'codex-usage', routes, render, startPolling, stopPolling, refresh };
}
