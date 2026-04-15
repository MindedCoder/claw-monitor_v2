import { existsSync, mkdirSync, writeFileSync, chmodSync, unlinkSync, createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir, platform, arch } from 'node:os';
import { spawn, execSync } from 'node:child_process';
import { generateToml } from './templates.js';
import { sendJson } from '../../src/lib/http-helpers.js';

const FRPC_VERSION = '0.61.1';

function detectPlatform() {
  const os = platform();
  const cpu = arch();
  let osName, archName;

  if (os === 'darwin') osName = 'darwin';
  else if (os === 'linux') osName = 'linux';
  else throw new Error(`Unsupported OS: ${os}`);

  if (cpu === 'arm64' || cpu === 'aarch64') archName = 'arm64';
  else if (cpu === 'x64') archName = 'amd64';
  else throw new Error(`Unsupported arch: ${cpu}`);

  return { osName, archName };
}

function findBinary() {
  const candidates = [
    join(homedir(), 'bin', 'frpc'),
    join(homedir(), '.local', 'bin', 'frpc'),
    '/usr/local/bin/frpc',
  ];
  return candidates.find(p => existsSync(p)) || null;
}

function getInstallDir() {
  const binDir = join(homedir(), 'bin');
  if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });
  return join(binDir, 'frpc');
}

export async function downloadFrpc(version = FRPC_VERSION) {
  const { osName, archName } = detectPlatform();
  const tarName = `frp_${version}_${osName}_${archName}`;
  const url = `https://github.com/fatedier/frp/releases/download/v${version}/${tarName}.tar.gz`;
  const destBin = getInstallDir();
  const tmpDir = join(homedir(), '.cache', 'claw-monitor-v2');

  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });

  const tarPath = join(tmpDir, `${tarName}.tar.gz`);

  // download
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(tarPath, buf);

  // extract
  execSync(`tar xzf "${tarPath}" -C "${tmpDir}"`, { stdio: 'pipe' });

  // copy binary
  const srcBin = join(tmpDir, tarName, 'frpc');
  if (!existsSync(srcBin)) throw new Error(`frpc binary not found in archive`);

  execSync(`cp "${srcBin}" "${destBin}"`, { stdio: 'pipe' });
  chmodSync(destBin, 0o755);

  // cleanup
  try { unlinkSync(tarPath); } catch {}

  return destBin;
}

export function isInstalled() {
  return findBinary() !== null;
}

export function getVersion() {
  const bin = findBinary();
  if (!bin) return null;
  try {
    const out = execSync(`"${bin}" --version`, { encoding: 'utf-8', timeout: 5000 }).trim();
    return out;
  } catch { return 'unknown'; }
}

export class FrpcService {
  name = 'frpc';
  #config;
  #child = null;
  #pid = null;
  #dataDir;
  #logFile;
  #configFile;
  #keepalive = false;
  #restartTimer = null;
  #restartCount = 0;
  #lastRestart = 0;
  #onLog = null;

  constructor(config, dataDir, onLog) {
    this.#config = config;
    this.#dataDir = dataDir;
    this.#logFile = join(dataDir, 'frpc.log');
    this.#configFile = join(dataDir, 'frpc.toml');
    this.#onLog = onLog || (() => {});
  }

  writeConfig() {
    const toml = generateToml(this.#config);
    writeFileSync(this.#configFile, toml);
    return this.#configFile;
  }

  start(keepalive = true) {
    if (this.isRunning()) return { already: true, pid: this.#pid };

    const bin = findBinary();
    if (!bin) throw new Error('frpc not installed. Call POST /api/frpc/install first.');

    this.writeConfig();
    this.#keepalive = keepalive;
    this.#spawn(bin);

    return { pid: this.#pid, keepalive };
  }

  #spawn(bin) {
    const log = createWriteStream(this.#logFile, { flags: 'a' });
    const child = spawn(bin || findBinary(), ['-c', this.#configFile], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    child.stdout.pipe(log);
    child.stderr.pipe(log);
    child.unref();

    this.#child = child;
    this.#pid = child.pid;

    child.on('exit', (code, signal) => {
      this.#child = null;
      this.#pid = null;

      if (!this.#keepalive) return;

      // backoff: if restarted within 10s, increase delay (max 30s)
      const now = Date.now();
      if (now - this.#lastRestart < 10000) {
        this.#restartCount++;
      } else {
        this.#restartCount = 0;
      }
      this.#lastRestart = now;
      const delay = Math.min(3000 * (this.#restartCount + 1), 30000);

      this.#onLog('warn', `frpc exited (code=${code}, signal=${signal}), restarting in ${delay / 1000}s...`);

      this.#restartTimer = setTimeout(() => {
        if (!this.#keepalive) return;
        try {
          this.#onLog('info', 'frpc keepalive: restarting...');
          this.#spawn();
        } catch (err) {
          this.#onLog('error', `frpc restart failed: ${err.message}`);
        }
      }, delay);
    });
  }

  stop() {
    this.#keepalive = false;
    if (this.#restartTimer) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    if (!this.#pid) return false;
    try { process.kill(this.#pid, 'SIGTERM'); } catch {}
    this.#child = null;
    this.#pid = null;
    return true;
  }

  isRunning() {
    if (!this.#pid) return false;
    try { process.kill(this.#pid, 0); return true; } catch { return false; }
  }

  status() {
    const bin = findBinary();
    return {
      installed: !!bin,
      version: bin ? getVersion() : null,
      running: this.isRunning(),
      pid: this.#pid,
      keepalive: this.#keepalive,
      restarts: this.#restartCount,
      configFile: this.#configFile,
    };
  }

  routes() {
    return {
      'GET /api/frpc/status': (req, res) => {
        sendJson(res, this.status());
      },
      'POST /api/frpc/start': (req, res) => {
        try {
          const result = this.start();
          sendJson(res, result);
        } catch (err) {
          sendJson(res, { error: err.message }, 500);
        }
      },
      'POST /api/frpc/stop': (req, res) => {
        const stopped = this.stop();
        sendJson(res, { stopped });
      },
      'POST /api/frpc/install': async (req, res) => {
        try {
          const binPath = await downloadFrpc();
          sendJson(res, { installed: true, path: binPath, version: getVersion() });
        } catch (err) {
          sendJson(res, { error: err.message }, 500);
        }
      },
    };
  }

  render() {
    const s = this.status();
    const statusClass = s.running ? 'ok' : (s.keepalive ? 'warn' : 'unknown');
    const statusText = s.running ? `运行中 (PID: ${this.#pid})` : (s.installed ? '已停止' : '未安装');
    const keepaliveText = s.keepalive ? '保活开启' : '保活关闭';
    const restartInfo = s.restarts > 0 ? ` | 重启 ${s.restarts} 次` : '';

    return `
      <div class="panel frpc-panel">
        <div class="panel-header">
          <h3>Frpc 隧道</h3>
          <span class="status-badge ${statusClass}">${s.running ? '运行中' : '已停止'}</span>
        </div>
        <div class="card-value">${statusText}</div>
        <div class="card-time">${keepaliveText}${restartInfo}${s.version ? ` | 版本: ${s.version}` : ''}</div>
      </div>`;
  }
}

