export async function fetchWithTimeout(url, opts = {}) {
  const { timeoutMs = 10000, ...fetchOpts } = opts;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...fetchOpts, signal: ac.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function headCheck(url, timeoutMs = 5000) {
  const start = Date.now();
  try {
    const res = await fetchWithTimeout(url, { method: 'HEAD', timeoutMs, redirect: 'follow' });
    return { ok: res.ok, status: res.status, ms: Date.now() - start };
  } catch (err) {
    return { ok: false, status: 0, ms: Date.now() - start, error: err.message };
  }
}

export async function getJson(url, headers = {}, timeoutMs = 10000) {
  const res = await fetchWithTimeout(url, { headers, timeoutMs });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
