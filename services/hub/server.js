const path = require('path');
const express = require('express');

const { HOST, PORT, DATA_ROOT, PULLER_URL, UPLOADS_ENABLED } = require('./lib/config');
const download = require('./lib/download');
const upload = require('./lib/upload');
const apps = require('./lib/apps');
const meta = require('./lib/meta');
const cleanup = require('./lib/cleanup');

const PUBLIC_DIR = path.join(__dirname, 'public');

console.log(`[hub] PULLER_URL=${PULLER_URL}`);

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR));

meta.register(app);
apps.register(app);
download.register(app);
if (UPLOADS_ENABLED) {
  upload.register(app);
}

app.get('/', (_request, response) => {
  response.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

if (require.main === module) {
  cleanup.start();
  app.listen(PORT, HOST, () => {
    console.log(`[hub] listening on http://${HOST}:${PORT} (DATA_ROOT=${DATA_ROOT})`);
  });
}

module.exports = app;
