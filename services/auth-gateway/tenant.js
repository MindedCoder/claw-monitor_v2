export function resolveTenant(path, config) {
  const tenants = config.tenants || {};
  const prefixes = Object.keys(tenants).sort((a, b) => b.length - a.length);

  for (const prefix of prefixes) {
    if (path.startsWith(prefix)) {
      return { prefix, ...tenants[prefix] };
    }
  }

  // default tenant
  return {
    prefix: '/',
    authProvider: config.authProvider || 'password',
    provider: config.provider || {},
  };
}
