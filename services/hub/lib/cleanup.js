const storage = require('./storage');
const { STALE_UPLOAD_MS, CLEANUP_INTERVAL_MS } = require('./config');

async function runOnce() {
  const now = Date.now();
  const stale = await storage.listStaleUploadSessions(now, STALE_UPLOAD_MS);
  for (const uploadId of stale) {
    await storage.removeUploadSession(uploadId);
  }
  return stale;
}

function start() {
  const tick = () => {
    runOnce().catch((error) => {
      console.error('[hub] cleanup error:', error.message);
    });
  };
  const timer = setInterval(tick, CLEANUP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

module.exports = { start, runOnce };
