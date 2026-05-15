/**
 * wecom-archive-relay panel
 *
 * 用途:把 saastemplate.cloud 推送的微信会话存档消息从公网(frpc 隧道)
 *      转发到本机 OpenClaw 上的 wecom-archive-inbound-plugin。
 *
 * 链路:
 *   saastemplate.cloud (forwardToOpenClaw)
 *     → HTTPS https://claw.bfelab.com/<tenant>/api/wecom-archive/ingest
 *     → nginx ingress (auth-gateway /api/* 白名单)
 *     → frpc 隧道 → 127.0.0.1:9001
 *     → 本 panel POST /api/wecom-archive/ingest
 *     → HTTP forward 到 127.0.0.1:<gatewayPort>/plugins/wecom-archive/ingest (本机 OpenClaw plugin)
 *
 * 鉴权:单 sharedSecret 透传(cloud / monitor / plugin 三处填一致)。
 *      panel 自己校 `X-OpenClaw-Webhook-Secret`,转发时原样传给 plugin。
 *
 * 失败传播:plugin 不通 / 4xx → panel 回 502,cloud 那边自动回写 forwardError。
 *
 * 配置:config.wecomArchiveRelay = {
 *   enabled?: boolean,         // 默认看是否填了 sharedSecret + pluginUrl
 *   sharedSecret: string,      // 必填
 *   pluginUrl: string,         // 必填, 形如 "http://127.0.0.1:18789/plugins/wecom-archive/ingest"
 *   timeoutMs?: number,        // 默认 7000 (cloud 端 forwardToOpenClaw 是 8s, 留 1s 余量)
 *   ringSize?: number          // 默认 100
 * }
 */

import { sendJson, readBody } from '../lib/http-helpers.js';
import { RingBuffer } from '../lib/ring-buffer.js';
import { fetchWithTimeout } from '../lib/fetch-utils.js';
import { esc, toBJ } from '../lib/html.js';

const DEFAULT_TIMEOUT_MS = 7000;
const DEFAULT_RING_SIZE = 100;
// 99% 客户机器 OpenClaw gateway 跑默认 18789 端口,plugin 路径固定;edge case 可在 config 显式覆盖 pluginUrl
const DEFAULT_PLUGIN_URL = 'http://127.0.0.1:18789/plugins/wecom-archive/ingest';

export default function createWecomArchiveRelayPanel(config, syslog) {
  const cfg = config.wecomArchiveRelay || {};
  const sharedSecret = cfg.sharedSecret || '';
  const pluginUrl = cfg.pluginUrl || DEFAULT_PLUGIN_URL;
  const enabled = cfg.enabled !== false && !!sharedSecret;
  const timeoutMs = Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const ringSize = Number(cfg.ringSize) > 0 ? Number(cfg.ringSize) : DEFAULT_RING_SIZE;

  const ring = new RingBuffer(ringSize);
  const counters = { received: 0, forwarded: 0, rejected: 0, errors: 0 };

  function log(level, msg) {
    if (syslog && typeof syslog.push === 'function') syslog.push(level, `[wecom-archive-relay] ${msg}`);
  }

  function record(entry) {
    ring.push({ ts: Date.now(), ...entry });
  }

  async function handleIngest(req, res) {
    counters.received++;

    if (!enabled) {
      counters.rejected++;
      record({ kind: 'rejected', reason: 'panel disabled' });
      return sendJson(res, { error: 'wecom-archive-relay disabled (missing sharedSecret/pluginUrl)' }, 503);
    }

    const provided = req.headers['x-openclaw-webhook-secret'];
    if (provided !== sharedSecret) {
      counters.rejected++;
      log('warn', `401 secret mismatch from ${req.socket.remoteAddress || '?'}`);
      record({ kind: 'rejected', reason: 'secret mismatch', from: req.socket.remoteAddress });
      return sendJson(res, { error: 'invalid secret' }, 401);
    }

    const body = await readBody(req);
    if (!body || typeof body !== 'object' || !body.msgId) {
      counters.rejected++;
      record({ kind: 'rejected', reason: 'invalid body' });
      return sendJson(res, { error: 'invalid body (msgId required)' }, 400);
    }

    // 转发到本机 OpenClaw plugin
    let upstreamStatus = 0;
    let upstreamBody = '';
    let networkErr = '';
    try {
      const resp = await fetchWithTimeout(pluginUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-OpenClaw-Webhook-Secret': sharedSecret,
        },
        body: JSON.stringify(body),
        timeoutMs,
      });
      upstreamStatus = resp.status;
      if (resp.status >= 400) {
        upstreamBody = (await resp.text().catch(() => '')).slice(0, 200);
      }
    } catch (err) {
      networkErr = String(err && err.message ? err.message : err).slice(0, 200);
    }

    const summary = {
      msgId: body.msgId,
      senderId: body.senderId,
      msgtype: body.msgtype,
      bfeClawInstanceId: body.bfeClawInstanceId,
    };

    if (networkErr) {
      counters.errors++;
      log('error', `forward ${body.msgId} → ${pluginUrl} network err: ${networkErr}`);
      record({ kind: 'error', ...summary, error: `network: ${networkErr}` });
      return sendJson(res, { error: `plugin unreachable: ${networkErr}` }, 502);
    }
    if (upstreamStatus >= 400) {
      counters.errors++;
      log('warn', `forward ${body.msgId} → plugin HTTP ${upstreamStatus} ${upstreamBody}`);
      record({ kind: 'error', ...summary, error: `plugin HTTP ${upstreamStatus} ${upstreamBody}` });
      return sendJson(res, { error: `plugin HTTP ${upstreamStatus}`, detail: upstreamBody }, 502);
    }

    counters.forwarded++;
    log('info', `forwarded ${body.msgId} senderId=${body.senderId || '?'} type=${body.msgtype || '?'} → ${upstreamStatus}`);
    record({ kind: 'forwarded', ...summary, upstreamStatus });

    // cloud 端 forwardToOpenClaw 期待 2xx 即成功 (它不读 body),返回 204 跟 plugin 行为对齐
    res.statusCode = 204;
    res.end();
  }

  function routes() {
    return {
      'POST /api/wecom-archive/ingest': handleIngest,
      'GET /api/wecom-archive/status': (req, res) => sendJson(res, {
        enabled,
        pluginUrl,
        timeoutMs,
        counters,
        recent: ring.toArray().slice(-20).reverse(),
      }),
    };
  }

  function render() {
    const recent = ring.toArray().slice(-10).reverse();
    const rows = recent.map(e => {
      const color = e.kind === 'forwarded' ? '#3fb950' : e.kind === 'rejected' ? '#f1fa8c' : '#f85149';
      const detail = e.kind === 'forwarded'
        ? `→ ${e.upstreamStatus}`
        : (e.error || e.reason || '');
      return `<tr>
        <td class="log-time">${esc(toBJ(e.ts))}</td>
        <td style="color:${color}">${esc(e.kind)}</td>
        <td>${esc(e.msgId || '-')}</td>
        <td>${esc(e.senderId || '-')}</td>
        <td>${esc(e.msgtype || '-')}</td>
        <td class="log-msg">${esc(detail)}</td>
      </tr>`;
    }).join('');

    const status = enabled
      ? `<span style="color:#3fb950">enabled</span> → ${esc(pluginUrl)}`
      : `<span style="color:#f1fa8c">disabled</span> (config 未填 sharedSecret/pluginUrl)`;

    return `
      <div class="panel wecom-archive-relay-panel">
        <div class="panel-header">
          <h3>微信会话存档中继</h3>
          <span class="log-count">收 ${counters.received} / 转 ${counters.forwarded} / 拒 ${counters.rejected} / 错 ${counters.errors}</span>
        </div>
        <div style="padding:6px 12px;font-size:12px;color:#8b949e">${status}</div>
        <div class="log-table-wrap">
          <table class="log-table">
            <thead><tr><th>时间</th><th>状态</th><th>msgId</th><th>senderId</th><th>msgtype</th><th>详情</th></tr></thead>
            <tbody>${rows || '<tr><td colspan="6" class="no-data">暂无消息</td></tr>'}</tbody>
          </table>
        </div>
      </div>`;
  }

  return { name: 'wecom-archive-relay', routes, render, counters, enabled };
}
