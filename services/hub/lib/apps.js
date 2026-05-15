// Hub read-side handlers proxy to claw-hub-puller. All app metadata lives on
// the puller's filesystem; hub is a thin frontend so multiple monitor
// instances on different hosts see the same centralized data.

const { PULLER_URL } = require('./config');
const { validateAppId, validateVersion } = require('./validate');

async function relayJson(upstreamUrl, response) {
  let upstream;
  try {
    upstream = await fetch(upstreamUrl);
  } catch (error) {
    response.status(502).json({ error: `puller unreachable: ${error.message}` });
    return;
  }
  const text = await upstream.text();
  const ct = upstream.headers.get('content-type');
  if (ct) response.setHeader('Content-Type', ct);
  response.status(upstream.status).send(text);
}

function register(app) {
  app.get('/api/apps', async (_request, response) => {
    await relayJson(`${PULLER_URL}/api/apps`, response);
  });

  app.get('/api/apps/:appId', async (request, response) => {
    try {
      const appId = validateAppId(request.params.appId);
      await relayJson(`${PULLER_URL}/api/apps/${encodeURIComponent(appId)}`, response);
    } catch (error) {
      response.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  app.get('/api/apps/:appId/versions/:version', async (request, response) => {
    try {
      const appId = validateAppId(request.params.appId);
      const version = validateVersion(request.params.version);
      await relayJson(
        `${PULLER_URL}/api/apps/${encodeURIComponent(appId)}/versions/${encodeURIComponent(version)}`,
        response
      );
    } catch (error) {
      response.status(error.statusCode || 500).json({ error: error.message });
    }
  });

  // Delete routes are no longer supported through hub — puller is the source
  // of truth and only it (or operator on the puller host) can mutate apps/.
}

module.exports = { register };
