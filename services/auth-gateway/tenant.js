export function resolveTenant(path, config) {
  const tenants = config.tenants || {};
  const prefixes = Object.keys(tenants).sort((a, b) => b.length - a.length);

  for (const prefix of prefixes) {
    if (path.startsWith(prefix)) {
      return { prefix, ...tenants[prefix] };
    }
  }

  // default tenant — extract prefix from path (e.g. "/huangcan/dashboard" → "/huangcan")
  const match = path.match(/^(\/[^/]+)/);
  const prefix = match ? match[1] : '/';
  return {
    prefix,
    authProvider: config.authProvider || 'password',
    provider: config.provider || {},
  };
}

/** Extract slug from tenant prefix for cookie naming, e.g. "/huangcan" → "huangcan" */
export function getTenantSlug(prefix) {
  const slug = prefix.replace(/^\/+|\/+$/g, '');
  return slug || 'default';
}
