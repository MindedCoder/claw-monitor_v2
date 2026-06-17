import { fetchWithTimeout } from '../lib/fetch-utils.js';
import { sendJson } from '../lib/http-helpers.js';
import { esc, relative } from '../lib/html.js';

function cleanBaseUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function text(value, fallback = '-') {
  if (isBlank(value)) return fallback;
  return String(value);
}

function percentClass(raw, state) {
  const value = Number(raw);
  if (state === 'critical' || value >= 90) return 'critical';
  if (state === 'warning' || value >= 75) return 'warn';
  return 'ok';
}

function statusClass(account) {
  if (account.available) return 'ok';
  if (account.runtime_status === 'rate_limited') return 'warn';
  return 'fail';
}

function statusLabel(account) {
  const managed = {
    monitored: '监控中',
    pending: '待处理',
    ignored: '已忽略',
  }[account.managed_status] || text(account.managed_status, '未纳管');
  const runtime = text(account.runtime_label || account.runtime_status, '-');
  return `${managed} / ${runtime}`;
}

function accountKey(account, index) {
  return [
    account.target_id,
    account.account_id,
    account.account,
    account.group,
    index,
  ].filter(Boolean).join(':');
}

function usageCell(label, raw, display, resetAt, state) {
  const shown = text(display);
  if (shown === '-') return '<span class="sub2api-muted">-</span>';
  const cls = percentClass(raw, state);
  const prefix = label ? `${label} ` : '';
  return `
    <div class="sub2api-usage-cell ${cls}">
      <span>${esc(prefix)}${esc(shown)}</span>
      <small>${esc(text(resetAt))}</small>
    </div>`;
}

function normalizePayload(data) {
  const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
  return {
    ok: data?.ok === true,
    customer: data?.customer || {},
    summary: data?.summary || {},
    accounts,
    bindings: Array.isArray(data?.bindings) ? data.bindings : [],
    discoveryErrors: Array.isArray(data?.discovery_errors) ? data.discovery_errors : [],
    updatedAt: data?.updated_at || null,
    cache: data?.cache || {},
  };
}

export default function createSub2apiUsagePanel(config) {
  const cfg = config.sub2apiUsage || {};
  const enabled = cfg.enabled === true;
  const monitorBaseUrl = cleanBaseUrl(cfg.monitorBaseUrl);
  const customerEmail = String(cfg.customerEmail || '').trim();
  const intervalMs = cfg.intervalMs || 30000;
  const cacheTtlMs = cfg.cacheTtlMs || 30000;
  const timeoutMs = cfg.timeoutMs || 8000;
  const staleTtlMs = cfg.staleTtlMs || 300000;
  const allowLocalRefresh = cfg.allowLocalRefresh === true;
  const allowUpstreamRefresh = cfg.allowUpstreamRefresh === true;
  const apiToken = String(cfg.apiToken || '').trim();

  const state = {
    enabled,
    configured: Boolean(monitorBaseUrl && customerEmail),
    customerEmail,
    lastCheck: null,
    lastSuccess: null,
    error: null,
    stale: false,
    data: null,
  };

  let timer = null;
  let inFlight = null;

  function headers() {
    const out = { Accept: 'application/json' };
    if (apiToken) out.Authorization = `Bearer ${apiToken}`;
    return out;
  }

  function publicState() {
    return {
      enabled: state.enabled,
      configured: state.configured,
      customerEmail: state.customerEmail,
      lastCheck: state.lastCheck,
      lastSuccess: state.lastSuccess,
      error: state.error,
      stale: state.stale,
      data: state.data,
    };
  }

  async function refresh({ force = false } = {}) {
    if (!enabled) return publicState();
    if (!state.configured) {
      state.error = 'sub2apiUsage is not configured';
      state.lastCheck = Date.now();
      return publicState();
    }

    const now = Date.now();
    const fresh = state.lastSuccess && now - state.lastSuccess < cacheTtlMs;
    if ((!force || !allowLocalRefresh) && fresh) return publicState();
    if (inFlight) return inFlight;

    inFlight = (async () => {
      const url = new URL(`${monitorBaseUrl}/api/customer-usage`);
      url.searchParams.set('email', customerEmail);
      if (force && allowUpstreamRefresh) url.searchParams.set('refresh', '1');

      try {
        const res = await fetchWithTimeout(url, { headers: headers(), timeoutMs });
        state.lastCheck = Date.now();
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        state.data = normalizePayload(data);
        state.error = null;
        state.stale = false;
        state.lastSuccess = state.lastCheck;
      } catch (err) {
        state.lastCheck = Date.now();
        state.error = err.message;
        state.stale = Boolean(state.data && state.lastSuccess && state.lastCheck - state.lastSuccess <= staleTtlMs);
        if (!state.stale) state.data = null;
      } finally {
        inFlight = null;
      }
      return publicState();
    })();

    return inFlight;
  }

  function startPolling() {
    if (!enabled) return;
    refresh();
    timer = setInterval(() => refresh(), intervalMs);
  }

  function stopPolling() {
    if (timer) clearInterval(timer);
  }

  function routes() {
    return {
      'GET /api/sub2api-usage': (req, res) => sendJson(res, publicState()),
      'GET /api/sub2api-usage/refresh': async (req, res) => {
        const result = await refresh({ force: true });
        sendJson(res, result);
      },
    };
  }

  function renderEmpty(message, detail = '') {
    return `
      <div class="panel sub2api-usage-panel">
        <div class="panel-header">
          <h3>上游账号用量</h3>
          <span class="status-badge unknown">未启用</span>
        </div>
        <div class="sub2api-empty">${esc(message)}</div>
        ${detail ? `<div class="card-time">${esc(detail)}</div>` : ''}
      </div>`;
  }

  function renderSummary(data) {
    const s = data.summary || {};
    const cards = [
      ['可用账号', `${text(s.available_accounts, 0)} / ${text(s.total_accounts, 0)}`],
      ['今日用量', `${text(s.today_tokens)} ${text(s.today_cost, '')}`],
      ['5H / 7D 峰值', `${text(s.five_hour_max)} / ${text(s.seven_day_max)}`],
      ['最近到期', text(s.nearest_credential_expiry || s.nearest_subscription_expiry)],
    ];

    return `
      <div class="sub2api-summary">
        ${cards.map(([label, value]) => `
          <div class="sub2api-summary-card">
            <span>${esc(label)}</span>
            <strong>${esc(value)}</strong>
          </div>`).join('')}
      </div>`;
  }

  function renderRows(data) {
    const accounts = data.accounts || [];
    if (accounts.length === 0) {
      return '<div class="sub2api-empty">暂无关联上游账号</div>';
    }

    return `
      <div class="sub2api-table-wrap">
        <table class="sub2api-table">
          <thead>
            <tr>
              <th>站点</th>
              <th>账号</th>
              <th>分组 / 平台</th>
              <th>状态</th>
              <th>5H</th>
              <th>7D</th>
              <th>订阅到期</th>
              <th>凭证到期</th>
            </tr>
          </thead>
          <tbody>
            ${accounts.map((account, index) => `
              <tr class="${statusClass(account)}" data-key="${esc(accountKey(account, index))}">
                <td>${esc(text(account.site || account.target_id))}</td>
                <td class="sub2api-account" title="${esc(text(account.account))}">${esc(text(account.account))}</td>
                <td>
                  <strong>${esc(text(account.group))}</strong>
                  <small>${esc(text(account.platform))}</small>
                </td>
                <td><span class="sub2api-status">${esc(statusLabel(account))}</span></td>
                <td>${usageCell('', account.usage_5h_raw, account.usage_5h, account.usage_5h_reset_at, account.usage_state)}</td>
                <td>${usageCell('', account.usage_7d_raw, account.usage_7d, account.usage_7d_reset_at, account.usage_state)}</td>
                <td>${esc(text(account.subscription_expires_at))}</td>
                <td>${esc(text(account.credential_expires_at))}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  }

  function render() {
    if (!enabled) return '';
    if (!state.configured) {
      return renderEmpty('请配置 sub2apiUsage.monitorBaseUrl 和 sub2apiUsage.customerEmail');
    }

    const data = state.data;
    const badgeCls = state.error ? (state.stale ? 'warn' : 'fail') : 'ok';
    const badgeText = state.error ? (state.stale ? '缓存' : '异常') : '正常';
    const detail = state.error
      ? `<div class="sub2api-error">${esc(state.error)}</div>`
      : '';
    const meta = [
      state.customerEmail,
      data?.updatedAt ? `中心更新 ${data.updatedAt}` : '',
      state.lastSuccess ? `本机更新 ${relative(state.lastSuccess)}` : '',
    ].filter(Boolean).join(' · ');

    return `
      <div class="panel sub2api-usage-panel">
        <div class="panel-header">
          <h3>上游账号用量</h3>
          <div class="sub2api-actions">
            <span class="status-badge ${badgeCls}">${badgeText}</span>
            <button onclick="refreshSub2apiUsage()" class="btn btn-sm">刷新</button>
          </div>
        </div>
        ${data ? renderSummary(data) : '<div class="sub2api-empty">正在获取用量数据</div>'}
        ${data ? renderRows(data) : ''}
        ${detail}
        <div class="card-time">${esc(meta || '-')}</div>
      </div>`;
  }

  return { name: 'sub2api-usage', routes, render, startPolling, stopPolling, refresh };
}
