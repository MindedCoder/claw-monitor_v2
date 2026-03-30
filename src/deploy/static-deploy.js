import { existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { sendJson, readBody } from '../lib/http-helpers.js';

export default function createDeployModule(config) {
  const staticDir = config.deploy?.staticDir || './data/static';
  const instanceName = config.instanceName || 'default';
  const deployLog = [];

  function ensureDir(dir) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  function copyDirRecursive(src, dest) {
    ensureDir(dest);
    for (const entry of readdirSync(src)) {
      const srcPath = join(src, entry);
      const destPath = join(dest, entry);
      if (statSync(srcPath).isDirectory()) {
        copyDirRecursive(srcPath, destPath);
      } else {
        copyFileSync(srcPath, destPath);
      }
    }
  }

  function deploy(htmlPath, platform, resources = []) {
    if (!existsSync(htmlPath)) {
      return { error: `file not found: ${htmlPath}` };
    }

    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '');

    const targetDir = join(staticDir, dateStr, platform);
    ensureDir(targetDir);

    const htmlName = `${timeStr}.html`;
    copyFileSync(htmlPath, join(targetDir, htmlName));

    const srcDir = dirname(htmlPath);
    for (const res of resources) {
      const resSrc = join(srcDir, res);
      if (existsSync(resSrc) && statSync(resSrc).isDirectory()) {
        copyDirRecursive(resSrc, join(targetDir, res));
      }
    }

    const urlPath = `/static/${dateStr}/${platform}/${htmlName}`;
    const record = {
      ts: now.toISOString(),
      htmlPath,
      platform,
      resources,
      url: urlPath,
    };
    deployLog.push(record);
    if (deployLog.length > 100) deployLog.shift();

    return { url: urlPath, instanceName };
  }

  function routes() {
    return {
      'POST /api/deploy': async (req, res) => {
        const body = await readBody(req);
        if (!body || !body.htmlPath || !body.platform) {
          return sendJson(res, { error: 'htmlPath and platform are required' }, 400);
        }
        const result = deploy(body.htmlPath, body.platform, body.resources || []);
        if (result.error) return sendJson(res, result, 400);
        sendJson(res, result);
      },
      'GET /api/deploy/history': (req, res) => sendJson(res, deployLog),
    };
  }

  function render() {
    const recent = deployLog.slice(-5).reverse();
    const items = recent.map(r =>
      `<li><a class="deploy-url" href="${r.url}">${r.platform} - ${r.ts.slice(0, 16)}</a></li>`
    ).join('');

    return `
      <div class="panel deploy-panel">
        <div class="panel-header">
          <h3>静态部署</h3>
          <span class="log-count">${deployLog.length} 次</span>
        </div>
        <ul class="deploy-list">${items || '<li class="no-data">暂无部署记录</li>'}</ul>
      </div>`;
  }

  return { name: 'deploy', routes, render, deploy };
}
