// Hub download handlers proxy to claw-hub-puller, streaming the artifact
// through with Range support and the upstream's Content-Disposition / ETag /
// Content-Length headers preserved.

const { Readable } = require('stream');

const { PULLER_URL } = require('./config');
const { validateAppId, validateVersion } = require('./validate');

const FORWARD_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'content-disposition',
  'accept-ranges',
  'etag',
  'last-modified',
];

function copyHeaders(upstream, response) {
  for (const name of FORWARD_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) response.setHeader(name, value);
  }
}

function register(app) {
  app.get('/api/download/:appId/latest', async (request, response) => {
    try {
      const appId = validateAppId(request.params.appId);
      const upstream = await fetch(
        `${PULLER_URL}/api/download/${encodeURIComponent(appId)}/latest`,
        { redirect: 'manual' }
      );
      if (upstream.status >= 300 && upstream.status < 400) {
        const location = upstream.headers.get('location') || '';
        // Puller returns a relative redirect (just the version segment), so
        // forwarding it as-is keeps the prefix the request arrived under.
        response.redirect(upstream.status, location);
        return;
      }
      copyHeaders(upstream, response);
      const text = await upstream.text();
      response.status(upstream.status).send(text);
    } catch (error) {
      if (error.statusCode) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }
      response.status(502).json({ error: `puller unreachable: ${error.message}` });
    }
  });

  app.get('/api/download/:appId/:version', async (request, response) => {
    try {
      const appId = validateAppId(request.params.appId);
      const version = validateVersion(request.params.version);

      const upstreamHeaders = {};
      if (request.headers.range) upstreamHeaders.range = request.headers.range;
      if (request.headers['if-none-match']) {
        upstreamHeaders['if-none-match'] = request.headers['if-none-match'];
      }

      const upstream = await fetch(
        `${PULLER_URL}/api/download/${encodeURIComponent(appId)}/${encodeURIComponent(version)}`,
        { headers: upstreamHeaders }
      );

      copyHeaders(upstream, response);
      response.status(upstream.status);

      if (!upstream.body) {
        response.end();
        return;
      }
      Readable.fromWeb(upstream.body).pipe(response);
    } catch (error) {
      if (error.statusCode) {
        response.status(error.statusCode).json({ error: error.message });
        return;
      }
      response.status(502).json({ error: `puller unreachable: ${error.message}` });
    }
  });
}

module.exports = { register };
