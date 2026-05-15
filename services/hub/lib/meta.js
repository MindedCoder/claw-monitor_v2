const storage = require('./storage');
const { INSTANCE_NAME, APP_TITLE, UPLOADS_ENABLED } = require('./config');

const pkg = require('../package.json');

function register(app) {
  app.get('/api/meta', async (_request, response) => {
    try {
      const appIds = await storage.listAppIds();
      const totalSize = await storage.totalSize();
      response.json({
        instanceName: INSTANCE_NAME,
        title: APP_TITLE,
        hubVersion: pkg.version,
        appCount: appIds.length,
        totalSize,
        uploadsEnabled: UPLOADS_ENABLED,
      });
    } catch (error) {
      response.status(500).json({ error: error.message });
    }
  });

  app.get('/healthz', (_request, response) => {
    response.json({ ok: true });
  });
}

module.exports = { register };
