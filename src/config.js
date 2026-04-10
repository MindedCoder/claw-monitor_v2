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

function loadOpenClawGatewayToken() {
  const openClawConfigPath = resolve(homedir(), '.openclaw/openclaw.json');
  if (!existsSync(openClawConfigPath)) return '';
  try {
    const cfg = loadJson(openClawConfigPath);
    return cfg?.gateway?.auth?.token || '';
  } catch {
    return '';
  }
}

function loadOpenClawControlUiToken() {
  const pairedPath = resolve(homedir(), '.openclaw/devices/paired.json');
  if (!existsSync(pairedPath)) return '';
  try {
    const paired = loadJson(pairedPath);
    const matches = Object.values(paired || {}).filter(
      (entry) => entry && entry.clientId === 'openclaw-control-ui' && entry.clientMode === 'webchat'
    );
    matches.sort((a, b) => {
      const at = Number(a?.tokens?.operator?.lastUsedAtMs || a?.approvedAtMs || a?.createdAtMs || 0);
      const bt = Number(b?.tokens?.operator?.lastUsedAtMs || b?.approvedAtMs || b?.createdAtMs || 0);
      return bt - at;
    });
    return matches[0]?.tokens?.operator?.token || '';
  } catch {
    return '';
  }
}

function loadPairedClientToken(clientId, clientMode = null) {
  const pairedPath = resolve(homedir(), '.openclaw/devices/paired.json');
  if (!existsSync(pairedPath)) return '';
  try {
    const paired = loadJson(pairedPath);
    const matches = Object.values(paired || {}).filter((entry) => {
      if (!entry || entry.clientId !== clientId) return false;
      if (clientMode && entry.clientMode !== clientMode) return false;
      return true;
    });
    matches.sort((a, b) => {
      const at = Number(a?.tokens?.operator?.lastUsedAtMs || a?.approvedAtMs || a?.createdAtMs || 0);
      const bt = Number(b?.tokens?.operator?.lastUsedAtMs || b?.approvedAtMs || b?.createdAtMs || 0);
      return bt - at;
    });
    return matches[0]?.tokens?.operator?.token || '';
  } catch {
    return '';
  }
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
  if (cfg.feishuStatus) {
    cfg.feishuStatus.gatewayToken = cfg.feishuStatus.gatewayToken || loadOpenClawGatewayToken();
    cfg.feishuStatus.gatewayClientToken =
      cfg.feishuStatus.gatewayClientToken || loadPairedClientToken('gateway-client', 'ui');
    cfg.feishuStatus.clientAuthToken =
      cfg.feishuStatus.clientAuthToken ||
      loadOpenClawControlUiToken() ||
      cfg.feishuStatus.gatewayClientToken ||
      cfg.feishuStatus.gatewayToken;
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
