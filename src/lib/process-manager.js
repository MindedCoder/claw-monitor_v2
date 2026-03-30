import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, createWriteStream } from 'node:fs';

export class ProcessManager {
  #procs = new Map();
  #pidFile;

  constructor(pidFile) {
    this.#pidFile = pidFile;
    this.#loadPids();
  }

  #loadPids() {
    if (!existsSync(this.#pidFile)) return;
    try {
      const data = JSON.parse(readFileSync(this.#pidFile, 'utf-8'));
      for (const [name, pid] of Object.entries(data)) {
        if (this.#isAlive(pid)) {
          this.#procs.set(name, { pid, process: null });
        }
      }
    } catch {}
  }

  #savePids() {
    const data = {};
    for (const [name, info] of this.#procs) {
      data[name] = info.pid;
    }
    writeFileSync(this.#pidFile, JSON.stringify(data, null, 2));
  }

  #isAlive(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  start(name, cmd, args, opts = {}) {
    this.stop(name);
    const { logFile, cwd, env } = opts;

    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    if (logFile) {
      const log = createWriteStream(logFile, { flags: 'a' });
      child.stdout?.pipe(log);
      child.stderr?.pipe(log);
    }

    child.unref();
    this.#procs.set(name, { pid: child.pid, process: child });
    this.#savePids();
    return child.pid;
  }

  stop(name) {
    const info = this.#procs.get(name);
    if (!info) return false;
    try {
      process.kill(info.pid, 'SIGTERM');
    } catch {}
    this.#procs.delete(name);
    this.#savePids();
    return true;
  }

  status(name) {
    const info = this.#procs.get(name);
    if (!info) return { running: false };
    const alive = this.#isAlive(info.pid);
    if (!alive) {
      this.#procs.delete(name);
      this.#savePids();
    }
    return { running: alive, pid: alive ? info.pid : null };
  }

  stopAll() {
    for (const name of [...this.#procs.keys()]) {
      this.stop(name);
    }
  }
}
