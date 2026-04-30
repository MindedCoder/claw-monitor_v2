const os = require('os');
const path = require('path');

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8125);

// DATA_ROOT is the on-disk root for all hub state. It is NEVER created at
// startup — directories are only materialized by storage.js the first time a
// write request arrives. This keeps the dev machine clean when hub is only
// meant to run on its host machine.
const DATA_ROOT = path.resolve(
  process.env.DATA_ROOT || path.join(os.homedir(), '.bfe-hub')
);

const APP_TITLE = process.env.APP_TITLE || 'BFE Hub';
const INSTANCE_NAME = process.env.INSTANCE_NAME || '';

// URL of the claw-hub-puller service. Hub forwards all read requests
// (/api/apps, /api/download/...) to this URL — there is no local-FS fallback.
// The puller is deployed as a single shared service for the whole fleet under
// instance "monitor"; every monitor host points at the same URL by default.
// Override via HUB_PULLER_URL env when needed (e.g. on the puller-hosting
// machine itself, set HUB_PULLER_URL=http://127.0.0.1:8126 to skip the public
// hop).
const PULLER_URL = (
  process.env.HUB_PULLER_URL || 'https://claw.bfelab.com/monitor/hub-puller'
).replace(/\/+$/, '');

// Default: anonymous (tailnet-only deployment, X-Auth-User not wired through
// nginx/auth-gateway yet). Set HUB_REQUIRE_AUTH=true once that's in place.
// Anonymous writers are recorded as 'anonymous' in manifests.
const REQUIRE_AUTH = process.env.HUB_REQUIRE_AUTH === 'true';

// Upload feature is disabled by default while the upload model is being
// redesigned (won't rely on browser-side end-user uploads). When disabled,
// upload API routes are not registered (404) and the frontend hides all
// upload entry points.
const UPLOADS_ENABLED = process.env.HUB_UPLOADS_ENABLED === 'true';

const MAX_VERSIONS_PER_APP = 3;
const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

const APP_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

module.exports = {
  HOST,
  PORT,
  DATA_ROOT,
  APP_TITLE,
  INSTANCE_NAME,
  PULLER_URL,
  REQUIRE_AUTH,
  UPLOADS_ENABLED,
  MAX_VERSIONS_PER_APP,
  STALE_UPLOAD_MS,
  CLEANUP_INTERVAL_MS,
  APP_ID_RE,
};
