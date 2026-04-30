const { REQUIRE_AUTH } = require('./config');

function getUser(request) {
  const header = request.headers['x-auth-user'];
  if (typeof header !== 'string' || header.trim().length === 0) {
    return null;
  }
  try {
    return decodeURIComponent(header.trim()).slice(0, 128);
  } catch (_err) {
    return header.trim().slice(0, 128);
  }
}

function requireUser(request, response) {
  const user = getUser(request);
  if (user) return user;
  if (!REQUIRE_AUTH) return 'anonymous';
  response.status(401).json({ error: 'authentication required' });
  return null;
}

module.exports = {
  getUser,
  requireUser,
};
