import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { RingBuffer } from '../lib/ring-buffer.js';
import { sendJson } from '../lib/http-helpers.js';
import { esc, toBJTime } from '../lib/html.js';

export default function createLogsPanel(config) {
  const cfg = config.logs || {};
  const maxEntries = cfg.maxEntries || 500;
  const sources = cfg.sources || [];

  const entries = new RingBuffer(maxEntries);
  const offsets = new Map();
  const sseClients = new Set();

  let timer = null;

  function readNewLines(source) {
    const { name, path } = source;
    if (!existsSync(path)) return [];

    const stat = statSync(path);
    const lastSize = offsets.get(path) || 0;

    if (stat.size <= lastSize) {
      if (stat.size < lastSize) offsets.set(path, 0); // file truncated
      return [];
    }

    const buf = Buffer.alloc(Math.min(stat.size - lastSize, 64 * 1024));
    const fd = openSync(path, 'r');
    readSync(fd, buf, 0, buf.length, lastSize);
    closeSync(fd);
    offsets.set(path, lastSize + buf.length);

    const text = buf.toString('utf-8');
    return text.split('\n').filter(Boolean).map(line => ({
      source: name,
      ts: Date.now(),
      line: line.trim(),
    }));
  }

  function tick() {
    for (const src of sources) {
      const newLines = readNewLines(src);
      for (const entry of newLines) {
        entries.push(entry);
        broadcast(entry);
      }
    }
  }

  function broadcast(entry) {
    const data = `data: ${JSON.stringify(entry)}\n\n`;
    for (const client of sseClients) {
      try { client.write(data); } catch { sseClients.delete(client); }
    }
  }

  function pushLog(source, line) {
    const entry = { source, ts: Date.now(), line };
    entries.push(entry);
    broadcast(entry);
  }

  function startPolling(intervalMs = 2000) {
    tick();
    timer = setInterval(tick, intervalMs);
  }

  function stopPolling() {
    if (timer) clearInterval(timer);
  }

  function routes() {
    return {
      'GET /api/logs': (req, res) => sendJson(res, entries.toArray()),
      'GET /api/logs/stream': (req, res) => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        });
        res.write('retry: 3000\n\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
      },
    };
  }

  function render() {
    const recent = entries.toArray().slice(-30);
    const rows = recent.map(e => `
      <tr>
        <td class="log-time">${toBJTime(e.ts)}</td>
        <td class="log-source">${esc(e.source)}</td>
        <td class="log-line">${esc(e.line)}</td>
      </tr>
    `).join('');

    return `
      <div class="panel logs-panel">
        <div class="panel-header">
          <h3>日志流</h3>
          <span class="log-count">${entries.length} 条</span>
        </div>
        <div class="log-table-wrap">
          <table class="log-table">
            <thead><tr><th>时间</th><th>来源</th><th>内容</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="3" class="no-data">暂无日志</td></tr>'}</tbody>
          </table>
        </div>
      </div>`;
  }

  return { name: 'logs', routes, render, startPolling, stopPolling, pushLog, entries };
}
