import { headCheck } from '../lib/fetch-utils.js';
import { RingBuffer } from '../lib/ring-buffer.js';
import { sendJson } from '../lib/http-helpers.js';

export default function createPingPanel(config) {
  const cfg = config.ping || {};
  const targets = cfg.targets || [
    { name: 'Google', url: 'https://www.google.com' },
    { name: 'Baidu', url: 'https://www.baidu.com' },
  ];
  const timeoutMs = cfg.timeoutMs || 10000;

  const state = {};
  for (const t of targets) {
    state[t.name] = { last: null, history: new RingBuffer(200) };
  }

  async function pingTarget(name) {
    const target = targets.find(t => t.name === name);
    if (!target) return { error: 'target not found' };
    const result = { ...await headCheck(target.url, timeoutMs), name: target.name, ts: Date.now() };
    state[target.name].last = result;
    state[target.name].history.push(result);
    return result;
  }

  async function pingAll() {
    const results = await Promise.all(targets.map(t => pingTarget(t.name)));
    return results;
  }

  function getStatus() {
    const out = {};
    for (const t of targets) {
      const s = state[t.name];
      out[t.name] = { last: s.last, historyCount: s.history.length };
    }
    return out;
  }

  function getHistory(name) {
    const s = state[name];
    return s ? s.history.toArray() : [];
  }

  function routes() {
    return {
      'GET /api/ping': (req, res) => sendJson(res, getStatus()),
      'GET /api/ping/trigger': async (req, res) => {
        const results = await pingAll();
        sendJson(res, results);
      },
      'GET /api/ping/trigger/one': async (req, res, url) => {
        const name = url.searchParams.get('name');
        if (!name) return sendJson(res, { error: 'name required' }, 400);
        const result = await pingTarget(name);
        sendJson(res, result);
      },
      'GET /api/ping/history': (req, res, url) => {
        const name = url.searchParams.get('name');
        if (!name) return sendJson(res, { error: 'name required' }, 400);
        sendJson(res, getHistory(name));
      },
    };
  }

  function render() {
    const cards = targets.map(t => {
      const s = state[t.name];
      const last = s.last;
      const statusClass = !last ? 'unknown' : last.ok ? 'ok' : 'fail';
      const statusText = !last ? '未检测' : last.ok ? `${last.ms}ms` : (last.error || `HTTP ${last.status}`);
      return `
        <div class="panel-card ping-card ${statusClass}">
          <div class="card-title">${t.name}</div>
          <div class="card-value">${statusText}</div>
          <div class="card-time">${last ? new Date(last.ts).toLocaleTimeString('zh-CN', { hour12: false }) : '-'}</div>
        </div>`;
    }).join('');

    return `
      <div class="panel ping-panel">
        <div class="panel-header">
          <h3>Ping 探测</h3>
          <button onclick="triggerPing()" class="btn btn-sm">立即检测</button>
        </div>
        <div class="panel-cards">${cards}</div>
      </div>`;
  }

  return { name: 'ping', routes, render, getStatus, pingAll, targets };
}
