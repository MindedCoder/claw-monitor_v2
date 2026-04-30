const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const { DATA_ROOT, MAX_VERSIONS_PER_APP } = require('./config');

// NOTE: DATA_ROOT is NEVER created at module load or server startup. It is
// created lazily via ensureDir() below on the first write path. Reads that
// land before any writes return empty lists without touching disk.

const APPS_DIR = path.join(DATA_ROOT, 'apps');
const UPLOADS_DIR = path.join(DATA_ROOT, 'uploads');

async function ensureDir(dirPath) {
  await fsp.mkdir(dirPath, { recursive: true });
}

async function pathExists(p) {
  try {
    await fsp.stat(p);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function readJsonOrNull(filePath) {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJsonAtomic(filePath, data) {
  await ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, filePath);
}

function appDir(appId) {
  return path.join(APPS_DIR, appId);
}

function appIndexPath(appId) {
  return path.join(appDir(appId), 'index.json');
}

function versionDir(appId, version) {
  return path.join(appDir(appId), 'versions', version);
}

function manifestPath(appId, version) {
  return path.join(versionDir(appId, version), 'manifest.json');
}

function uploadDir(uploadId) {
  return path.join(UPLOADS_DIR, uploadId);
}

function uploadChunksDir(uploadId) {
  return path.join(uploadDir(uploadId), 'chunks');
}

function uploadMetaPath(uploadId) {
  return path.join(uploadDir(uploadId), 'meta.json');
}

async function listAppIds() {
  try {
    const entries = await fsp.readdir(APPS_DIR, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function readAppIndex(appId) {
  return readJsonOrNull(appIndexPath(appId));
}

async function readManifest(appId, version) {
  return readJsonOrNull(manifestPath(appId, version));
}

async function versionExists(appId, version) {
  return pathExists(versionDir(appId, version));
}

async function findArtifact(appId, version) {
  const dir = versionDir(appId, version);
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  const artifact = entries.find((name) => name.startsWith('artifact.'));
  return artifact ? path.join(dir, artifact) : null;
}

function artifactExtFromFilename(filename) {
  const ext = path.extname(filename);
  return ext || '.bin';
}

async function createUploadSession(meta) {
  await ensureDir(uploadChunksDir(meta.uploadId));
  await writeJsonAtomic(uploadMetaPath(meta.uploadId), meta);
}

async function readUploadMeta(uploadId) {
  return readJsonOrNull(uploadMetaPath(uploadId));
}

async function writeUploadMeta(uploadId, meta) {
  await writeJsonAtomic(uploadMetaPath(uploadId), meta);
}

async function writeChunk(uploadId, index, stream) {
  const chunksDir = uploadChunksDir(uploadId);
  await ensureDir(chunksDir);
  const chunkPath = path.join(chunksDir, `${index}.part`);
  const tmp = `${chunkPath}.tmp`;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    stream.on('error', reject);
    out.on('error', reject);
    out.on('finish', resolve);
    stream.pipe(out);
  });
  await fsp.rename(tmp, chunkPath);
}

async function finalizeUpload(uploadId, meta) {
  const chunksDir = uploadChunksDir(uploadId);
  const destDir = versionDir(meta.appId, meta.version);
  await ensureDir(destDir);

  const ext = artifactExtFromFilename(meta.filename);
  const artifactPath = path.join(destDir, `artifact${ext}`);
  const tmpArtifact = `${artifactPath}.tmp`;

  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(tmpArtifact);

  for (let i = 0; i < meta.totalChunks; i += 1) {
    const chunkPath = path.join(chunksDir, `${i}.part`);
    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(chunkPath);
      input.on('data', (buf) => hash.update(buf));
      input.on('error', reject);
      input.on('end', resolve);
      input.pipe(out, { end: false });
    });
  }

  await new Promise((resolve, reject) => {
    out.end((err) => (err ? reject(err) : resolve()));
  });

  const digest = hash.digest('hex');
  if (meta.sha256 && digest !== meta.sha256) {
    await fsp.unlink(tmpArtifact).catch(() => {});
    const error = new Error(`sha256 mismatch (expected ${meta.sha256}, got ${digest})`);
    error.statusCode = 400;
    throw error;
  }

  await fsp.rename(tmpArtifact, artifactPath);

  const manifest = {
    appId: meta.appId,
    version: meta.version,
    name: meta.name || meta.appId,
    description: meta.description || '',
    instructions: meta.instructions || '',
    filename: meta.filename,
    size: meta.size,
    sha256: digest,
    uploader: meta.uploader || '',
    uploadedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(manifestPath(meta.appId, meta.version), manifest);

  return manifest;
}

async function updateAppIndex(appId, { name, description }) {
  const versionsDir = path.join(appDir(appId), 'versions');
  let entries = [];
  try {
    entries = await fsp.readdir(versionsDir);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const versions = [];
  const manifestsByVersion = new Map();
  for (const version of entries) {
    const manifest = await readManifest(appId, version);
    if (!manifest) continue;
    manifestsByVersion.set(manifest.version, manifest);
    versions.push({
      version: manifest.version,
      uploadedAt: manifest.uploadedAt,
      size: manifest.size,
      uploader: manifest.uploader || '',
    });
  }

  versions.sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));

  const existing = (await readAppIndex(appId)) || {};
  const latest = versions.length > 0 ? versions[0].version : null;
  const latestManifest = latest ? manifestsByVersion.get(latest) : null;
  const index = {
    appId,
    name: name || (latestManifest && latestManifest.name) || existing.name || appId,
    description:
      description ||
      (latestManifest && latestManifest.description) ||
      existing.description ||
      '',
    instructions: latestManifest ? latestManifest.instructions || '' : '',
    uploader: latestManifest ? latestManifest.uploader || '' : existing.uploader || '',
    latest,
    versions,
  };
  await writeJsonAtomic(appIndexPath(appId), index);
  return index;
}

async function pruneOldVersions(appId) {
  const index = await readAppIndex(appId);
  if (!index || index.versions.length <= MAX_VERSIONS_PER_APP) return [];

  const toPrune = index.versions.slice(MAX_VERSIONS_PER_APP);
  for (const entry of toPrune) {
    await fsp.rm(versionDir(appId, entry.version), { recursive: true, force: true });
  }
  return toPrune.map((entry) => entry.version);
}

async function removeUploadSession(uploadId) {
  await fsp.rm(uploadDir(uploadId), { recursive: true, force: true });
}

async function removeVersion(appId, version) {
  await fsp.rm(versionDir(appId, version), { recursive: true, force: true });
}

async function removeApp(appId) {
  await fsp.rm(appDir(appId), { recursive: true, force: true });
}

async function totalSize() {
  let total = 0;
  const appIds = await listAppIds();
  for (const appId of appIds) {
    const index = await readAppIndex(appId);
    if (!index) continue;
    for (const v of index.versions) total += v.size || 0;
  }
  return total;
}

async function listStaleUploadSessions(now, maxAgeMs) {
  let entries;
  try {
    entries = await fsp.readdir(UPLOADS_DIR, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const stale = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const meta = await readUploadMeta(entry.name);
    if (!meta) {
      stale.push(entry.name);
      continue;
    }
    const created = Date.parse(meta.createdAt || '');
    if (!Number.isFinite(created) || now - created > maxAgeMs) {
      stale.push(entry.name);
    }
  }
  return stale;
}

module.exports = {
  DATA_ROOT,
  APPS_DIR,
  UPLOADS_DIR,
  listAppIds,
  readAppIndex,
  readManifest,
  versionExists,
  findArtifact,
  createUploadSession,
  readUploadMeta,
  writeUploadMeta,
  writeChunk,
  finalizeUpload,
  updateAppIndex,
  pruneOldVersions,
  removeUploadSession,
  removeVersion,
  removeApp,
  totalSize,
  listStaleUploadSessions,
};
