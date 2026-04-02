const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8123);
const ROOT_PATH = path.resolve(process.env.ROOT_PATH || path.join(os.homedir(), '.openclaw'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const ROOT_ID = 'root';
const ROOT_LABEL = process.env.APP_TITLE || path.basename(ROOT_PATH) || 'filedeck';
const DEFAULT_ENTRY_NAME = process.env.DEFAULT_ENTRY_NAME || 'workspace';

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.js',
  '.ts',
  '.jsx',
  '.tsx',
  '.css',
  '.html',
  '.xml',
  '.yml',
  '.yaml',
  '.log',
  '.sh',
  '.zsh',
  '.bash',
  '.ps1',
  '.sql',
  '.csv',
  '.jsonl',
]);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
};

const directoryPayloadCache = new Map();
const filePayloadCache = new Map();

function getOrCreateId(filePath) {
  if (filePath === ROOT_PATH) {
    return ROOT_ID;
  }
  const relativePath = path.relative(ROOT_PATH, filePath);
  return `n:${encodeURIComponent(relativePath)}`;
}

function resolveNodePath(nodeId) {
  if (!nodeId || nodeId === ROOT_ID) {
    return ROOT_PATH;
  }

  if (typeof nodeId !== 'string' || !nodeId.startsWith('n:')) {
    throw new Error('Unknown node id');
  }

  let relativePath;
  try {
    relativePath = decodeURIComponent(nodeId.slice(2));
  } catch (_error) {
    throw new Error('Unknown node id');
  }

  const filePath = path.resolve(ROOT_PATH, relativePath);
  if (filePath !== ROOT_PATH && !filePath.startsWith(`${ROOT_PATH}${path.sep}`)) {
    throw new Error('Invalid node id');
  }

  return filePath;
}

function getMimeType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function isTextPreviewable(filePath) {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function safeReadUtf8(filePath, maxBytes = 1024 * 1024) {
  const stats = fs.statSync(filePath);
  const truncated = stats.size > maxBytes;
  const size = truncated ? maxBytes : stats.size;
  const buffer = Buffer.alloc(size);
  const fd = fs.openSync(filePath, 'r');

  try {
    fs.readSync(fd, buffer, 0, size, 0);
  } finally {
    fs.closeSync(fd);
  }

  return {
    content: buffer.toString('utf8'),
    truncated,
  };
}

function readEntry(currentPath) {
  const stats = fs.statSync(currentPath);
  const entry = {
    id: getOrCreateId(currentPath),
    name: currentPath === ROOT_PATH ? ROOT_LABEL : path.basename(currentPath),
    type: stats.isDirectory() ? 'directory' : 'file',
    modifiedAt: stats.mtime.toISOString(),
  };

  if (stats.isDirectory()) {
    entry.itemCount = fs.readdirSync(currentPath).length;
  } else {
    entry.size = stats.size;
    entry.ext = path.extname(currentPath).toLowerCase();
  }

  return entry;
}

function readChildren(directoryPath) {
  return fs
    .readdirSync(directoryPath, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .sort((left, right) => {
      if (left.isDirectory() !== right.isDirectory()) {
        return left.isDirectory() ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    })
    .map((entry) => readEntry(path.join(directoryPath, entry.name)));
}

function buildBreadcrumb(currentPath) {
  const breadcrumb = [];
  let cursor = currentPath;

  while (true) {
    breadcrumb.push({
      id: getOrCreateId(cursor),
      name: cursor === ROOT_PATH ? ROOT_LABEL : path.basename(cursor),
    });

    if (cursor === ROOT_PATH) {
      break;
    }

    cursor = path.dirname(cursor);
  }

  return breadcrumb.reverse();
}

function getDirectoryPayload(directoryPath) {
  const stats = fs.statSync(directoryPath);
  if (!stats.isDirectory()) {
    throw new Error('Expected a directory');
  }

  const cacheKey = `${stats.mtimeMs}:${stats.size}`;
  const cached = directoryPayloadCache.get(directoryPath);
  if (cached && cached.cacheKey === cacheKey) {
    return cached.payload;
  }

  const payload = {
    id: getOrCreateId(directoryPath),
    name: directoryPath === ROOT_PATH ? ROOT_LABEL : path.basename(directoryPath),
    type: 'directory',
    modifiedAt: stats.mtime.toISOString(),
    breadcrumb: buildBreadcrumb(directoryPath),
    children: readChildren(directoryPath),
  };

  if (directoryPath === ROOT_PATH) {
    const defaultDirectoryPath = getDefaultDirectoryPath();
    payload.defaultDirectoryId = getOrCreateId(defaultDirectoryPath);
  }

  directoryPayloadCache.set(directoryPath, { cacheKey, payload });
  return payload;
}

function getPreviewKind(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const mimeType = getMimeType(filePath);

  if (extension === '.pdf') return 'pdf';
  if (extension === '.json') return 'json';
  if (extension === '.md' || extension === '.markdown') return 'markdown';
  if (isTextPreviewable(filePath)) return 'text';
  if (mimeType.startsWith('image/')) return 'image';
  return 'download';
}

function getDefaultDirectoryPath() {
  const candidatePath = path.join(ROOT_PATH, DEFAULT_ENTRY_NAME);
  try {
    if (fs.statSync(candidatePath).isDirectory()) {
      return candidatePath;
    }
  } catch (_error) {
  }
  return ROOT_PATH;
}

const app = express();
app.use(express.static(PUBLIC_DIR));

app.get('/api/tree', (_request, response) => {
  try {
    response.json(getDirectoryPayload(ROOT_PATH));
  } catch (error) {
    response.status(500).json({ error: error.message });
  }
});

app.get('/api/node', (request, response) => {
  try {
    const directoryPath = resolveNodePath(request.query.id);
    response.json(getDirectoryPayload(directoryPath));
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.get('/api/file', (request, response) => {
  try {
    const filePath = resolveNodePath(request.query.id);
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      response.status(400).json({ error: 'Expected a file id, received a directory id' });
      return;
    }

    const cacheKey = `${stats.mtimeMs}:${stats.size}`;
    const cached = filePayloadCache.get(filePath);
    if (cached && cached.cacheKey === cacheKey) {
      response.json(cached.payload);
      return;
    }

    const previewKind = getPreviewKind(filePath);
    const payload = {
      id: getOrCreateId(filePath),
      name: path.basename(filePath),
      ext: path.extname(filePath).toLowerCase(),
      size: stats.size,
      mimeType: getMimeType(filePath),
      modifiedAt: stats.mtime.toISOString(),
      previewKind,
      breadcrumb: buildBreadcrumb(filePath),
      rawUrl: `api/raw?id=${encodeURIComponent(getOrCreateId(filePath))}`,
      copyPath: filePath,
    };

    if (previewKind === 'json' || previewKind === 'markdown' || previewKind === 'text') {
      const { content, truncated } = safeReadUtf8(filePath);
      payload.content = content;
      payload.truncated = truncated;
    }

    filePayloadCache.set(filePath, { cacheKey, payload });
    response.json(payload);
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.get('/api/raw', (request, response) => {
  try {
    const filePath = resolveNodePath(request.query.id);
    const stats = fs.statSync(filePath);
    if (stats.isDirectory()) {
      response.status(400).json({ error: 'Expected a file id, received a directory id' });
      return;
    }

    const fileName = path.basename(filePath);
    const asciiName = fileName.replace(/[^\x20-\x7E]/g, '_');
    const utf8Name = encodeURIComponent(fileName);
    response.setHeader('Content-Type', getMimeType(filePath));
    response.setHeader('Content-Length', stats.size);
    response.setHeader('Content-Disposition', 'inline; filename="' + asciiName + '"; filename*=UTF-8\x27\x27' + utf8Name);
    fs.createReadStream(filePath).pipe(response);
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
});

app.get('/', (_request, response) => {
  response.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// When imported as a module, export the app; when run directly, listen
if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Open http://${HOST}:${PORT}`);
  });
}

module.exports = app;
