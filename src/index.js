import { resolve } from 'node:path';
import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { renderFull, renderInner } from './dashboard/renderer.js';
import { sendHtml, sendJson } from './lib/http-helpers.js';

import createPingPanel from './panels/ping.js';
import createCodexPanel from './panels/codex-usage.js';
import createHealthPanel from './panels/health.js';
import createLogsPanel from './panels/logs.js';
import createSystemLogPanel from './panels/system-log.js';
import createDeployModule from './deploy/static-deploy.js';
import { FrpcService } from '../services/frpc/manager.js';

async function main() {
  const config = loadConfig();
  const dataDir = resolve(config._root, 'data');

  console.log(`[claw-monitor-v2] starting... instance=${config.instanceName}`);

  // init panels
  const ping = createPingPanel(config);
  const codex = createCodexPanel(config);
  const health = createHealthPanel(config);
  const logs = createLogsPanel(config);
  const syslog = createSystemLogPanel();
  const deploy = createDeployModule(config);
  const frpc = new FrpcService(config, dataDir, (level, msg) => syslog.push(level, msg));

  const panels = [health, ping, codex, logs, syslog, deploy, frpc];

  // collect all routes
  const routes = new Map();

  // dashboard routes
  routes.set('GET /', (req, res) => sendHtml(res, renderFull(config, panels)));
  routes.set('GET /api/html', (req, res) => sendHtml(res, renderInner(panels)));
  routes.set('GET /api/status', (req, res) => {
    sendJson(res, {
      instance: config.instanceName,
      uptime: process.uptime(),
      health: health.getStatus(),
      ping: ping.getStatus(),
    });
  });
  routes.set('GET /healthz', (req, res) => {
    res.writeHead(200);
    res.end('ok');
  });

  // register panel routes
  for (const panel of panels) {
    if (typeof panel.routes === 'function') {
      const panelRoutes = panel.routes();
      for (const [key, handler] of Object.entries(panelRoutes)) {
        routes.set(key, handler);
      }
    }
  }

  // start server
  const port = config.port || 9001;
  const server = createServer(config, routes);
  server.listen(port, () => {
    console.log(`[claw-monitor-v2] dashboard on http://127.0.0.1:${port}`);
  });

  // start polling panels
  health.startPolling();
  codex.startPolling();
  logs.startPolling();

  // log startup
  syslog.push('info', `Claw Monitor v2 started on port ${port}`);

  // start frpc (requires serverAddr configured)
  if (config.frpc?.serverAddr) {
    try {
      const result = frpc.start();
      syslog.push('info', `frpc started, pid=${result.pid || 'already running'}`);
    } catch (err) {
      syslog.push('error', `frpc start failed: ${err.message}`);
    }
  }

  // optionally start auth-gateway
  if (config.authGateway?.enabled) {
    try {
      const { startGateway } = await import('../services/auth-gateway/gateway.js');
      await startGateway(config.authGateway);
      syslog.push('info', `auth-gateway started on port ${config.authGateway.port || 4180}`);
    } catch (err) {
      syslog.push('error', `auth-gateway start failed: ${err.message}`);
    }
  }

  // graceful shutdown
  const shutdown = () => {
    console.log('[claw-monitor-v2] shutting down...');
    health.stopPolling();
    codex.stopPolling();
    logs.stopPolling();
    frpc.stop();
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(err => {
  console.error('[claw-monitor-v2] fatal:', err);
  process.exit(1);
});
