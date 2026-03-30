export function generateToml(config) {
  const frpc = config.frpc || {};
  const lines = [];

  lines.push(`serverAddr = "${frpc.serverAddr || '127.0.0.1'}"`);
  lines.push(`serverPort = ${frpc.serverPort || 7000}`);
  if (frpc.token) {
    lines.push(`auth.token = "${frpc.token}"`);
  }
  lines.push('');

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
