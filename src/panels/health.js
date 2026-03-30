import { headCheck } from '../lib/fetch-utils.js';
import { RingBuffer } from '../lib/ring-buffer.js';
import { sendJson } from '../lib/http-helpers.js';
import { relative } from '../lib/html.js';

export default function createHealthPanel(config) {
  const cfg = config.health || {};
  const url = cfg.url || 'http://127.0.0.1:18789/health';
  const intervalMs = cfg.intervalMs || 5000;
  const timeoutMs = cfg.timeoutMs || 5000;
  const failThreshold = cfg.failThreshold || 3;

  const state = {
    status: 'unknown',
    consecutiveFails: 0,
    lastCheck: null,
    lastOk: null,
    downSince: null,
    history: new RingBuffer(100),
  };

  let timer = null;

  async function check() {
    const result = await headCheck(url, timeoutMs);
    result.ts = Date.now();
    state.lastCheck = result.ts;
    state.history.push(result);

    if (result.ok) {
      state.status = 'ok';
      state.consecutiveFails = 0;
      state.lastOk = result.ts;
      state.downSince = null;
    } else {
      state.consecutiveFails++;
      if (state.consecutiveFails >= failThreshold) {
        if (state.status !== 'down') {
          state.downSince = result.ts;
        }
        state.status = 'down';
      } else {
        state.status = 'degraded';
      }
    }
    return result;
  }

  function startPolling() {
    if (!cfg.enabled) return;
    check();
    timer = setInterval(check, intervalMs);
  }

  function stopPolling() {
    if (timer) clearInterval(timer);
  }

  function getStatus() {
    return {
      status: state.status,
      consecutiveFails: state.consecutiveFails,
      lastCheck: state.lastCheck,
      lastOk: state.lastOk,
      downSince: state.downSince,
      historyCount: state.history.length,
    };
  }

  function routes() {
    return {
      'GET /api/health': (req, res) => sendJson(res, getStatus()),
      'GET /api/health/check': async (req, res) => {
        const result = await check();
        sendJson(res, { ...getStatus(), lastResult: result });
      },
      'GET /api/health/history': (req, res) => sendJson(res, state.history.toArray()),
    };
  }

  function render() {
    const statusMap = { ok: '正常', down: '宕机', degraded: '异常', unknown: '未知' };
    const colorMap = { ok: 'ok', down: 'fail', degraded: 'warn', unknown: 'unknown' };

    const bars = state.history.toArray().slice(-50).map(h =>
      `<span class="health-bar ${h.ok ? 'ok' : 'fail'}" title="${new Date(h.ts).toLocaleTimeString('zh-CN', { hour12: false })} ${h.ok ? h.ms + 'ms' : h.error || 'fail'}"></span>`
    ).join('');

    const downInfo = state.downSince
      ? `<div class="down-info">宕机时长: ${relative(state.downSince)}</div>`
      : '';

    return `
      <div class="panel health-panel">
        <div class="panel-header">
          <h3>OpenClaw 状态</h3>
          <span class="status-badge ${colorMap[state.status]}">${statusMap[state.status]}</span>
        </div>
        <div class="health-bars">${bars || '<span class="no-data">暂无数据</span>'}</div>
        ${downInfo}
        <div class="card-time">上次检测: ${state.lastCheck ? relative(state.lastCheck) : '-'}</div>
      </div>`;
  }

  return { name: 'health', routes, render, startPolling, stopPolling, getStatus, check };
}
