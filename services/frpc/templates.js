export function generateToml(config) {
  const frpc = config.frpc || {};
  const lines = [];

  lines.push(`serverAddr = "${frpc.serverAddr || '8.135.54.217'}"`);
  lines.push(`serverPort = ${frpc.serverPort || 7000}`);
  lines.push('');

  if (frpc.token) {
    lines.push(`auth.token = "${frpc.token}"`);
    lines.push('');
  }

  // transport
  const t = frpc.transport;
  if (t) {
    if (t.heartbeatInterval) lines.push(`transport.heartbeatInterval = ${t.heartbeatInterval}`);
    if (t.heartbeatTimeout) lines.push(`transport.heartbeatTimeout = ${t.heartbeatTimeout}`);
    if (t.protocol) lines.push(`transport.protocol = "${t.protocol}"`);
    lines.push('');
  }

  // loginFailExit
  if (frpc.loginFailExit === false) {
    lines.push('loginFailExit = false');
    lines.push('');
  }

  const proxies = frpc.proxies || [];
  for (const p of proxies) {
    lines.push('[[proxies]]');
    lines.push(`name = "${p.name}"`);
    lines.push(`type = "${p.type || 'tcp'}"`);
    lines.push(`localIP = "${p.localIP || '127.0.0.1'}"`);
    lines.push(`localPort = ${p.localPort}`);

    if (p.remotePort) {
      lines.push(`remotePort = ${p.remotePort}`);
    }
    if (p.customDomains?.length) {
      lines.push(`customDomains = [${p.customDomains.map(d => `"${d}"`).join(', ')}]`);
    }
    if (p.subdomain) {
      lines.push(`subdomain = "${p.subdomain}"`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
