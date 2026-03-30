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
    data: null,
  };

  let timer = null;

  function readToken() {
    if (!authPath || !existsSync(authPath)) return null;
    try {
      const data = JSON.parse(readFileSync(authPath, 'utf-8'));

      // format: { profiles: { "openai:default": { key: "sk-..." } } }
      if (data.profiles && typeof data.profiles === 'object') {
        for (const p of Object.values(data.profiles)) {
          if (p.key) return p.key;
          if (p.accessToken) return p.accessToken;
        }
      }

      // format: [{ accessToken: "..." }]
      if (Array.isArray(data)) {
        const p = data.find(p => p.accessToken || p.key);
        return p?.accessToken || p?.key || null;
      }

      return data.accessToken || data.key || null;
    } catch { return null; }
  }

  async function refresh() {
    const token = readToken();
    if (!token) {
      state.error = 'token not found';
      state.lastCheck = Date.now();
      return state;
    }

    try {
      const res = await fetchWithTimeout(USAGE_API, {
        timeoutMs: 15000,
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'Mozilla/5.0',
          'Accept': 'application/json',
        },
      });

      if (!res.ok) {
        state.error = `HTTP ${res.status}`;
        state.lastCheck = Date.now();
        return state;
      }

      const body = await res.json();
      state.data = parseUsage(body);
      state.error = null;
    } catch (err) {
      state.error = err.message;
    }
    state.lastCheck = Date.now();
    return state;
  }

  function parseUsage(body) {
    const result = { raw: body };

    // extract rate limit windows
    if (body.rate_limits) {
      result.limits = body.rate_limits.map(rl => ({
        name: rl.name || rl.window,
        used: rl.used,
        cap: rl.cap,
        pct: rl.cap > 0 ? Math.round((rl.used / rl.cap) * 100) : 0,
        resetsAt: rl.resets_at,
      }));
    }

    if (body.usage_summary) {
      result.summary = body.usage_summary;
    }

    return result;
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
    } else if (!state.data) {
      content = `<div class="card-value unknown">未获取</div>`;
    } else if (state.data.limits) {
      content = state.data.limits.map(l => `
        <div class="usage-row">
          <span class="usage-label">${esc(l.name)}</span>
          <div class="progress-bar">
            <div class="progress-fill ${l.pct > 80 ? 'warn' : ''}" style="width:${l.pct}%"></div>
          </div>
          <span class="usage-pct">${l.pct}%</span>
        </div>
      `).join('');
    } else {
      content = `<pre class="raw-json">${esc(JSON.stringify(state.data.raw, null, 2).slice(0, 500))}</pre>`;
    }

    return `
      <div class="panel codex-panel">
        <div class="panel-header">
          <h3>Codex 使用量</h3>
          <button onclick="refreshCodex()" class="btn btn-sm">刷新</button>
        </div>
        ${content}
        <div class="card-time">更新: ${state.lastCheck ? new Date(state.lastCheck).toLocaleTimeString('zh-CN', { hour12: false }) : '-'}</div>
      </div>`;
  }

  return { name: 'codex-usage', routes, render, startPolling, stopPolling, refresh };
}
