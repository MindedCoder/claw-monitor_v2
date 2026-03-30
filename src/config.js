import { readFileSync, existsSync, watchFile } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~') ? p.replace('~', homedir()) : p;
}

function resolveRelative(p) {
  if (!p) return p;
  p = expandHome(p);
  return resolve(ROOT, p);
}

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

export function loadConfig() {
  const userConf = resolve(ROOT, 'data/config.json');
  const defaultConf = resolve(ROOT, 'config.example.json');
  const confPath = existsSync(userConf) ? userConf : defaultConf;
  const cfg = loadJson(confPath);

  // resolve paths
  if (cfg.codexUsage?.authProfilesPath) {
    cfg.codexUsage.authProfilesPath = expandHome(cfg.codexUsage.authProfilesPath);
  }
  if (cfg.logs?.sources) {
    cfg.logs.sources = cfg.logs.sources.map(s => ({ ...s, path: expandHome(s.path) }));
  }
  if (cfg.deploy?.staticDir) {
    cfg.deploy.staticDir = resolveRelative(cfg.deploy.staticDir);
  }

  cfg._root = ROOT;
  cfg._confPath = confPath;
  return cfg;
}

export function watchConfig(callback) {
  const userConf = resolve(ROOT, 'data/config.json');
  if (!existsSync(userConf)) return;
  watchFile(userConf, { interval: 3000 }, () => {
    try {
      const cfg = loadConfig();
      callback(cfg);
    } catch {}
  });
}
