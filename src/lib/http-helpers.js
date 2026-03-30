export function parseUrl(req) {
  return new URL(req.url, `http://${req.headers.host || 'localhost'}`);
}

export function parseCookies(req) {
  const h = req.headers.cookie || '';
  const map = {};
  for (const pair of h.split(';')) {
    const [k, ...v] = pair.trim().split('=');
    if (k) map[k] = decodeURIComponent(v.join('='));
  }
  return map;
}

export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve(null);
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

export function sendHtml(res, html, status = 200) {
  const body = typeof html === 'string' ? html : '';
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function send404(res) {
  sendJson(res, { error: 'not found' }, 404);
}

export function sendText(res, text, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}
