const crypto = require('crypto');

const storage = require('./storage');
const { requireUser } = require('./auth');
const {
  validateAppId,
  validateVersion,
  validateFilename,
  validateSize,
  validateSha256,
  validateChunkSize,
  validateInstructions,
} = require('./validate');

function newUploadId() {
  return 'u_' + crypto.randomBytes(9).toString('hex');
}

function missingChunks(meta) {
  const received = new Set(meta.receivedChunks);
  const missing = [];
  for (let i = 0; i < meta.totalChunks; i += 1) {
    if (!received.has(i)) missing.push(i);
  }
  return missing;
}

function register(app) {
  app.post('/api/upload/init', async (request, response) => {
    try {
      const user = requireUser(request, response);
      if (!user) return;

      const body = request.body || {};
      const appId = validateAppId(body.appId);
      const version = validateVersion(body.version);
      const filename = validateFilename(body.filename);
      const size = validateSize(body.size);
      const sha256 = validateSha256(body.sha256);
      const chunkSize = validateChunkSize(body.chunkSize);
      const instructions = validateInstructions(body.instructions);

      if (await storage.versionExists(appId, version)) {
        response.status(409).json({
          error: 'version already exists (bump version number to publish)',
        });
        return;
      }

      const uploadId = newUploadId();
      const totalChunks = Math.ceil(size / chunkSize);
      const meta = {
        uploadId,
        appId,
        version,
        name: typeof body.name === 'string' ? body.name.slice(0, 120) : '',
        description:
          typeof body.description === 'string' ? body.description.slice(0, 2000) : '',
        instructions,
        filename,
        size,
        sha256,
        chunkSize,
        totalChunks,
        receivedChunks: [],
        uploader: user,
        createdAt: new Date().toISOString(),
      };

      await storage.createUploadSession(meta);
      response.json({ uploadId, totalChunks, receivedChunks: [] });
    } catch (error) {
      response.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  app.get('/api/upload/status', async (request, response) => {
    try {
      const uploadId = String(request.query.uploadId || '');
      if (!/^u_[a-f0-9]+$/.test(uploadId)) {
        response.status(400).json({ error: 'invalid uploadId' });
        return;
      }
      const meta = await storage.readUploadMeta(uploadId);
      if (!meta) {
        response.status(404).json({ error: 'upload session not found' });
        return;
      }
      response.json({
        uploadId,
        totalChunks: meta.totalChunks,
        receivedChunks: meta.receivedChunks,
        missing: missingChunks(meta),
      });
    } catch (error) {
      response.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  app.put('/api/upload/chunk', async (request, response) => {
    try {
      const user = requireUser(request, response);
      if (!user) return;

      const uploadId = String(request.query.uploadId || '');
      if (!/^u_[a-f0-9]+$/.test(uploadId)) {
        response.status(400).json({ error: 'invalid uploadId' });
        return;
      }
      const index = Number(request.query.index);
      if (!Number.isInteger(index) || index < 0) {
        response.status(400).json({ error: 'invalid chunk index' });
        return;
      }
      const meta = await storage.readUploadMeta(uploadId);
      if (!meta) {
        response.status(404).json({ error: 'upload session not found' });
        return;
      }
      if (meta.uploader !== user) {
        response.status(403).json({ error: 'forbidden (different uploader)' });
        return;
      }
      if (index >= meta.totalChunks) {
        response.status(400).json({ error: 'chunk index out of range' });
        return;
      }

      await storage.writeChunk(uploadId, index, request);

      if (!meta.receivedChunks.includes(index)) {
        meta.receivedChunks.push(index);
        meta.receivedChunks.sort((a, b) => a - b);
        await storage.writeUploadMeta(uploadId, meta);
      }

      response.json({ ok: true, received: meta.receivedChunks });
    } catch (error) {
      response.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  app.post('/api/upload/complete', async (request, response) => {
    try {
      const user = requireUser(request, response);
      if (!user) return;

      const uploadId = String(request.query.uploadId || '');
      if (!/^u_[a-f0-9]+$/.test(uploadId)) {
        response.status(400).json({ error: 'invalid uploadId' });
        return;
      }
      const meta = await storage.readUploadMeta(uploadId);
      if (!meta) {
        response.status(404).json({ error: 'upload session not found' });
        return;
      }
      if (meta.uploader !== user) {
        response.status(403).json({ error: 'forbidden (different uploader)' });
        return;
      }
      const missing = missingChunks(meta);
      if (missing.length > 0) {
        response.status(400).json({ error: 'missing chunks', missing });
        return;
      }
      if (await storage.versionExists(meta.appId, meta.version)) {
        response.status(409).json({ error: 'version already exists' });
        return;
      }

      await storage.finalizeUpload(uploadId, meta);
      await storage.updateAppIndex(meta.appId, {
        name: meta.name,
        description: meta.description,
      });
      const pruned = await storage.pruneOldVersions(meta.appId);
      if (pruned.length > 0) {
        await storage.updateAppIndex(meta.appId, {
          name: meta.name,
          description: meta.description,
        });
      }
      await storage.removeUploadSession(uploadId);

      const base = request.baseUrl || '';
      response.json({
        ok: true,
        appId: meta.appId,
        version: meta.version,
        downloadUrl: `${base}/api/download/${encodeURIComponent(meta.appId)}/${encodeURIComponent(meta.version)}`,
        prunedVersions: pruned,
      });
    } catch (error) {
      response.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  app.delete('/api/upload/abort', async (request, response) => {
    try {
      const user = requireUser(request, response);
      if (!user) return;

      const uploadId = String(request.query.uploadId || '');
      if (!/^u_[a-f0-9]+$/.test(uploadId)) {
        response.status(400).json({ error: 'invalid uploadId' });
        return;
      }
      const meta = await storage.readUploadMeta(uploadId);
      if (meta && meta.uploader !== user) {
        response.status(403).json({ error: 'forbidden (different uploader)' });
        return;
      }
      await storage.removeUploadSession(uploadId);
      response.json({ ok: true });
    } catch (error) {
      response.status(error.statusCode || 500).json({ error: error.message });
    }
  });
}

module.exports = { register };
