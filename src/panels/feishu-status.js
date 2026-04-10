import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { sendJson } from '../lib/http-helpers.js';
import { esc } from '../lib/html.js';

const execFileAsync = promisify(execFile);

const DEFAULTS = {
  enabled: true,
  gatewayUrl: 'ws://localhost:18789',
  gatewayToken: '',
  clientAuthToken: '',
  gatewayClientToken: '',
  activeMinutes: 240,
  limit: 200,
  refreshIntervalMs: 5000,
  replyWindowMs: 10 * 1000,
  thinkingWindowMs: 2 * 60 * 1000,
  staleMs: 3 * 60 * 1000,
  idleMs: 30 * 60 * 1000,
  onlyFeishu: true,
  connectTimeoutMs: 8000,
};

function relTime(ts) {
  if (!ts) return '-';
  const diff = Date.now() - Number(ts);
  if (diff < 1000) return '刚刚';
  if (diff < 60_000) return `${Math.floor(diff / 1000)}秒前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
  return `${Math.floor(diff / 86_400_000)}天前`;
}

function isFeishuKey(key = '') {
  const lower = String(key).toLowerCase();
  return lower.includes(':feishu:') || lower.includes(':lark:');
}

function customerName(row) {
  if (typeof row?.displayName === 'string' && row.displayName.trim()) return row.displayName.trim();
  if (typeof row?.label === 'string' && row.label.trim()) return row.label.trim();
  const key = String(row?.key || '');
  const parts = key.split(':');
  return parts[parts.length - 1] || key || '未知客户';
}

function extractSenderNameFromText(text, senderId = '') {
  const patterns = [
    /"name"\s*:\s*"([^"]+)"/,
    /"sender"\s*:\s*"([^"]+)"/,
    /"label"\s*:\s*"([^"]+?)\s*\([^"]+\)"/,
  ];
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    const value = match?.[1]?.trim();
    if (value && value !== senderId) return value;
  }
  return '';
}

function loadSessionSenderName(sessionId, senderId = '') {
  if (!sessionId) return '';
  try {
    const filePath = resolve(homedir(), `.openclaw/agents/main/sessions/${sessionId}.jsonl`);
    const text = readFileSync(filePath, 'utf8');
    const lines = text.trim().split('\n').reverse();
    for (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const content = Array.isArray(record?.message?.content) ? record.message.content : [];
      const textParts = content
        .filter((item) => item?.type === 'text' && typeof item?.text === 'string')
        .map((item) => item.text);
      if (!textParts.length) continue;
      const combined = textParts.join('\n');
      if (!combined.includes('Sender (untrusted metadata)') && !combined.includes('"sender"')) continue;
      const name = extractSenderNameFromText(combined, senderId);
      if (name) return name;
    }
  } catch {}
  return '';
}

function parseAssistantPhase(record) {
  const content = Array.isArray(record?.message?.content) ? record.message.content : [];
  const hasToolCall = content.some((item) => item?.type === 'toolCall');
  const hasThinking = content.some((item) => item?.type === 'thinking');
  const textItems = content.filter((item) => item?.type === 'text');
  const hasText = textItems.length > 0;
  const hasFinalAnswer = textItems.some((item) => String(item?.textSignature || '').includes('"phase":"final_answer"'));

  if (hasText && !hasFinalAnswer) return 'replying';
  if (hasToolCall || hasThinking) return 'thinking';
  if (hasFinalAnswer) return 'replying';
  return 'idle';
}

function loadSessionPhase(sessionId) {
  if (!sessionId) return 'idle';
  try {
    const filePath = resolve(homedir(), `.openclaw/agents/main/sessions/${sessionId}.jsonl`);
    const text = readFileSync(filePath, 'utf8');
    const lines = text.trim().split('\n').reverse();
    for (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record?.type !== 'message') continue;
      const role = record?.message?.role;
      if (role === 'assistant') return parseAssistantPhase(record);
      if (role === 'toolResult') return 'thinking';
      if (role === 'user') return 'thinking';
    }
  } catch {}
  return 'idle';
}

function contextPct(row) {
  const total = Number(row?.totalTokens || 0);
  const ctx = Number(row?.contextTokens || 0);
  if (!ctx) return null;
  return Math.round((total / ctx) * 100);
}

function contextClass(pct) {
  if (pct == null) return 'unknown';
  if (pct >= 80) return 'fail';
  if (pct >= 60) return 'warn';
  return 'ok';
}

function deriveStatus(row, cfg, phase = 'idle') {
  const updatedAt = Number(row?.updatedAt || 0);
  const ageMs = updatedAt ? Date.now() - updatedAt : Number.MAX_SAFE_INTEGER;
  if (phase === 'thinking' && ageMs <= cfg.thinkingWindowMs) {
    return { code: 'warn', text: '思考中', detail: '用户刚发来消息，正在处理或调用工具' };
  }
  if (phase === 'replying' && ageMs <= cfg.replyWindowMs) {
    return { code: 'ok', text: '回复中', detail: '刚产生回复或正在连续输出' };
  }
  return { code: 'unknown', text: '休息中', detail: '当前没有进行中的处理' };
}

function closeSocket(ws) {
  if (!ws) return;
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  } catch {}
}

function uniqCandidates(candidates) {
  const seen = new Set();
  return candidates.filter((candidate) => {
    if (!candidate?.authToken) return false;
    const key = `${candidate.client.id}:${candidate.client.mode}:${candidate.authToken}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function requestGateway(cfg) {
  return new Promise((resolve, reject) => {
    const candidates = uniqCandidates([
      cfg.gatewayToken
        ? {
            authToken: cfg.gatewayToken,
            client: {
              id: 'gateway-client',
              version: '2026.4.10',
              platform: process.platform,
              mode: 'backend',
            },
            scopes: ['operator.read', 'operator.admin'],
          }
        : null,
      cfg.gatewayClientToken
        ? {
            authToken: cfg.gatewayClientToken,
            client: {
              id: 'gateway-client',
              version: '2026.4.10',
              platform: process.platform,
              mode: 'backend',
            },
            scopes: ['operator.read', 'operator.admin'],
          }
        : null,
      cfg.clientAuthToken
        ? {
            authToken: cfg.clientAuthToken,
            client: {
              id: 'openclaw-control-ui',
              version: '2026.3.13',
              platform: 'MacIntel',
              mode: 'webchat',
            },
            scopes: ['operator.read', 'operator.admin', 'operator.approvals', 'operator.pairing'],
          }
        : null,
    ]);

    if (!candidates.length) {
      reject(new Error('missing gateway auth token'));
      return;
    }
    let candidateIndex = 0;

    const tryNext = (lastError) => {
      if (candidateIndex >= candidates.length) {
        reject(lastError || new Error('gateway connect failed'));
        return;
      }
      const candidate = candidates[candidateIndex++];
      let seq = 0;
      let settled = false;
      let connectDone = false;
      let listDone = false;
      let ws;
      const pending = new Map();
      const timeout = setTimeout(() => {
        finish(new Error('gateway request timeout'));
      }, cfg.connectTimeoutMs);

      function cleanup() {
        clearTimeout(timeout);
        for (const [, handlers] of pending) {
          handlers.reject(new Error('gateway disconnected'));
        }
        pending.clear();
        closeSocket(ws);
      }

      function finish(err, payload) {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) {
          const mode = `${candidate.client.id}/${candidate.client.mode}`;
          const wrapped = new Error(`${mode}: ${err.message || String(err)}`);
          tryNext(wrapped);
        } else {
          resolve(payload);
        }
      }

      function sendRequest(method, params) {
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          return Promise.reject(new Error('gateway not connected'));
        }
        const id = `fs-${Date.now()}-${++seq}`;
        return new Promise((resolveReq, rejectReq) => {
          pending.set(id, { resolve: resolveReq, reject: rejectReq });
          ws.send(JSON.stringify({ type: 'req', id, method, params }));
        });
      }

      try {
        ws = new WebSocket(cfg.gatewayUrl);
      } catch (err) {
        finish(err);
        return;
      }

      ws.addEventListener('open', async () => {
        try {
          await sendRequest('connect', {
            minProtocol: 3,
            maxProtocol: 3,
            client: {
              ...candidate.client,
              instanceId: `feishu-status-${Date.now()}`,
            },
            role: 'operator',
            scopes: candidate.scopes,
            auth: { token: candidate.authToken },
            userAgent: 'claw-monitor-v2/1.0.0',
            locale: 'zh-CN',
          });
          connectDone = true;
          const payload = await sendRequest('sessions.list', {
            activeMinutes: cfg.activeMinutes,
            limit: cfg.limit,
            includeGlobal: false,
            includeUnknown: true,
          });
          listDone = true;
          finish(null, payload);
        } catch (err) {
          finish(err);
        }
      });

      ws.addEventListener('message', (event) => {
        let msg;
        try {
          msg = JSON.parse(String(event.data || ''));
        } catch {
          return;
        }
        if (msg.type !== 'res') return;
        const handlers = pending.get(msg.id);
        if (!handlers) return;
        pending.delete(msg.id);
        if (msg.ok) handlers.resolve(msg.payload);
        else handlers.reject(new Error(msg.error?.message || 'request failed'));
      });

      ws.addEventListener('close', (event) => {
        if (!settled && (!connectDone || !listDone)) {
          finish(new Error(`gateway closed (${event.code})`));
        }
      });

      ws.addEventListener('error', () => {
        if (!settled) finish(new Error('gateway websocket error'));
      });
    };

    tryNext();
  });
}

async function requestSessionsViaCli(cfg) {
  const timeoutMs = Math.max(3000, cfg.connectTimeoutMs || 8000);
  const { stdout } = await execFileAsync(
    'openclaw',
    [
      '--log-level',
      'silent',
      'sessions',
      '--active',
      String(cfg.activeMinutes),
      '--all-agents',
      '--json',
    ],
    {
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    }
  );

  const text = String(stdout || '').trim();
  if (!text) throw new Error('openclaw sessions returned empty output');
  const payload = JSON.parse(text);
  return {
    sessions: Array.isArray(payload?.sessions) ? payload.sessions : [],
    source: 'openclaw-cli',
  };
}

export default function createFeishuStatusPanel(config) {
  const cfg = { ...DEFAULTS, ...(config.feishuStatus || {}) };
  const state = {
    enabled: cfg.enabled,
    mode: 'server-polling',
    gatewayUrl: cfg.gatewayUrl,
    activeMinutes: cfg.activeMinutes,
    refreshIntervalMs: cfg.refreshIntervalMs,
    onlyFeishu: cfg.onlyFeishu,
    total: 0,
    active: 0,
    highContext: 0,
    idle: 0,
    rows: [],
    lastError: null,
    lastRefreshAt: null,
  };

  let timer = null;
  let running = false;

  async function refresh() {
    if (running || !cfg.enabled) return;
    running = true;
    try {
      let payload;
      try {
        payload = await requestSessionsViaCli(cfg);
      } catch (cliErr) {
        payload = await requestGateway(cfg).catch((gwErr) => {
          throw new Error(`cli: ${cliErr?.message || String(cliErr)}; gateway: ${gwErr?.message || String(gwErr)}`);
        });
      }
      const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];
      const rows = sessions
        .filter((row) => (cfg.onlyFeishu ? isFeishuKey(row?.key) : true))
        .map((row) => {
          const phase = loadSessionPhase(row?.sessionId);
          const status = deriveStatus(row, cfg, phase);
          const pct = contextPct(row);
          const senderId = String(row?.sender_id || row?.senderId || '');
          const transcriptName = loadSessionSenderName(row?.sessionId, senderId);
          return {
            key: row?.key || '',
            model: row?.model || '未知',
            label: row?.label || row?.displayName || '-',
            updatedAt: Number(row?.updatedAt || 0),
            customerName: transcriptName || customerName(row),
            contextPct: pct,
            status,
          };
        })
        .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));

      state.rows = rows;
      state.total = rows.length;
      state.active = rows.filter((row) => row.status.text === '回复中').length;
      state.highContext = rows.filter((row) => (row.contextPct || 0) >= 80).length;
      state.idle = rows.filter((row) => row.status.text === '休息中').length;
      state.lastError = null;
      state.lastRefreshAt = Date.now();
    } catch (err) {
      state.lastError = err?.message || String(err);
    } finally {
      running = false;
    }
  }

  function getStatus() {
    return {
      ...state,
      rows: state.rows,
    };
  }

  function routes() {
    return {
      'GET /api/feishu-status': (req, res) => sendJson(res, getStatus()),
    };
  }

  function render() {
    if (!cfg.enabled) {
      return `
        <div class="panel feishu-status-panel">
          <div class="panel-header">
            <h3>飞书聊天状态</h3>
            <span class="status-badge unknown">已禁用</span>
          </div>
          <div class="no-data">feishuStatus.enabled=false</div>
        </div>`;
    }

    const badgeClass = state.lastError ? 'fail' : state.lastRefreshAt ? 'ok' : 'warn';
    const badgeText = state.lastError ? '异常' : state.lastRefreshAt ? '已连接' : '初始化';
    const rowsHtml = state.rows
      .slice(0, 30)
      .map((row) => {
        const detail = row.status.detail ? `<div class="feishu-line feishu-detail">${esc(row.status.detail)}</div>` : '';
        const contextBadge = row.contextPct == null ? '未知' : `${row.contextPct}%`;
        return `
          <tr>
            <td>
              <div class="feishu-name">${esc(row.customerName)}</div>
            </td>
            <td><span class="status-badge ${row.status.code}">${esc(row.status.text)}</span></td>
            <td><span class="status-badge ${contextClass(row.contextPct)}">${esc(contextBadge)}</span></td>
            <td>${esc(row.model)}</td>
            <td>${esc(relTime(row.updatedAt))}</td>
            <td>${esc(row.label)}</td>
          </tr>
          <tr class="feishu-subrow">
            <td colspan="6">${detail}</td>
          </tr>`;
      })
      .join('');

    return `
      <div class="panel feishu-status-panel">
        <div class="panel-header">
          <h3>飞书聊天状态</h3>
          <span class="status-badge ${badgeClass}">${badgeText}</span>
        </div>
        <div class="panel-cards">
          <div class="panel-card ok"><div class="card-title">会话总数</div><div class="card-value">${state.total}</div></div>
          <div class="panel-card ok"><div class="card-title">最近活跃</div><div class="card-value">${state.active}</div></div>
          <div class="panel-card warn"><div class="card-title">高上下文</div><div class="card-value">${state.highContext}</div></div>
          <div class="panel-card unknown"><div class="card-title">休息中</div><div class="card-value">${state.idle}</div></div>
        </div>
        ${state.lastError ? `<div class="claw-error">${esc(state.lastError)}</div>` : ''}
        <div class="card-time">最近同步: ${esc(state.lastRefreshAt ? relTime(state.lastRefreshAt) : '-')}</div>
        <div class="log-table-wrap feishu-table-wrap">
          <table class="log-table feishu-table">
            <thead><tr><th>客户</th><th>状态</th><th>Context</th><th>模型</th><th>活跃</th><th>标签</th></tr></thead>
            <tbody>${rowsHtml || '<tr><td colspan="6" class="no-data">暂无飞书会话数据</td></tr>'}</tbody>
          </table>
        </div>
      </div>`;
  }

  function startPolling() {
    if (!cfg.enabled) return;
    refresh();
    timer = setInterval(refresh, Math.max(3000, cfg.refreshIntervalMs));
  }

  function stopPolling() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { name: 'feishu-status', routes, render, startPolling, stopPolling, getStatus };
}
