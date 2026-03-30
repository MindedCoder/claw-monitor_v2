import { RingBuffer } from '../lib/ring-buffer.js';
import { sendJson } from '../lib/http-helpers.js';
import { readBody } from '../lib/http-helpers.js';
import { esc, toBJTime } from '../lib/html.js';

export default function createSystemLogPanel() {
  const entries = new RingBuffer(300);
  const sseClients = new Set();

  function push(level, msg) {
    const entry = { level, msg, ts: Date.now() };
    entries.push(entry);
    broadcast(entry);
  }

  function broadcast(entry) {
    const data = `data: ${JSON.stringify(entry)}\n\n`;
    for (const client of sseClients) {
      try { client.write(data); } catch { sseClients.delete(client); }
    }
  }

  function routes() {
    return {
      'GET /api/system-log': (req, res) => sendJson(res, entries.toArray()),
      'POST /api/system-log': async (req, res) => {
        const body = await readBody(req);
        if (!body || !body.msg) return sendJson(res, { error: 'msg required' }, 400);
        push(body.level || 'info', body.msg);
        sendJson(res, { ok: true });
      },
      'GET /api/system-log/stream': (req, res) => {
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
    const recent = entries.toArray().slice(-20);
    const levelColor = { info: '#8be9fd', warn: '#f1fa8c', error: '#ff5555' };

    const rows = recent.map(e => `
      <tr>
        <td class="log-time">${toBJTime(e.ts)}</td>
        <td class="log-level" style="color:${levelColor[e.level] || '#ccc'}">${esc(e.level)}</td>
        <td class="log-msg">${esc(e.msg)}</td>
      </tr>
    `).join('');

    return `
      <div class="panel syslog-panel">
        <div class="panel-header">
          <h3>系统日志</h3>
          <span class="log-count">${entries.length} 条</span>
        </div>
        <div class="log-table-wrap">
          <table class="log-table">
            <thead><tr><th>时间</th><th>级别</th><th>内容</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="3" class="no-data">暂无日志</td></tr>'}</tbody>
          </table>
        </div>
      </div>`;
  }

  return { name: 'system-log', routes, render, push, entries };
}
