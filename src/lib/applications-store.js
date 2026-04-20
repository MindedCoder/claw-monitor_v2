import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

export const APPLICATIONS_PUBLIC_DIR = resolve(REPO_ROOT, 'services', 'applications', 'public');
export const APPLICATIONS_STORE_DIR = resolve(homedir(), '.openclaw', 'workspace', 'applications');
export const APPLICATIONS_STORE_PATH = resolve(APPLICATIONS_STORE_DIR, 'applications.json');

function ensureStoreDir() {
  if (!existsSync(APPLICATIONS_STORE_DIR)) mkdirSync(APPLICATIONS_STORE_DIR, { recursive: true });
}

export function loadApplications() {
  ensureStoreDir();
  if (!existsSync(APPLICATIONS_STORE_PATH)) return [];
  try {
    const parsed = JSON.parse(readFileSync(APPLICATIONS_STORE_PATH, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveApplications(list) {
  ensureStoreDir();
  writeFileSync(APPLICATIONS_STORE_PATH, JSON.stringify(list, null, 2), 'utf8');
}
