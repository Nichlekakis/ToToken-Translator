import http from 'node:http';
import https from 'node:https';
import { VERSION } from './config.js';
import { RewriteCache } from './store.js';
import { transformBody } from './transform.js';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function forward(req, res, upstream, body, log) {
  const target = new URL(req.url, upstream);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k)) headers[k] = v;
  headers.host = target.host;
  if (body) headers['content-length'] = Buffer.byteLength(body);
  const lib = target.protocol === 'http:' ? http : https;
  const up = lib.request(target, { method: req.method, headers }, (upRes) => {
    const outHeaders = {};
    for (const [k, v] of Object.entries(upRes.headers)) {
      if (!HOP_BY_HOP.has(k) || k === 'content-length') outHeaders[k] = v;
    }
    res.writeHead(upRes.statusCode || 502, outHeaders);
    upRes.pipe(res); // streams SSE untouched
  });
  up.on('error', (err) => {
    log(`upstream error: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `ToToken proxy: upstream unreachable (${err.message})` } }));
    } else {
      res.destroy(err);
    }
  });
  res.on('close', () => up.destroy());
  if (body) up.end(body);
  else req.pipe(up);
}

export function createProxy({ config, cache = new RewriteCache({ maxEntries: config.maxCacheEntries }), fetchImpl, log = () => {} }) {
  const server = http.createServer(async (req, res) => {
    const pathname = (req.url || '').split('?')[0];
    if (pathname === '/__totoken/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: VERSION, mode: config.mode }));
      return;
    }
    const isMessages = req.method === 'POST' && (pathname === '/v1/messages' || pathname === '/v1/messages/count_tokens');
    if (!isMessages || config.mode === 'off') {
      forward(req, res, config.upstream, null, log);
      return;
    }
    let raw;
    try {
      raw = await readBody(req);
    } catch {
      res.destroy();
      return;
    }
    let out = raw;
    try {
      const body = JSON.parse(raw.toString('utf8'));
      const { changed, results } = await transformBody(body, {
        config,
        cache,
        headers: req.headers,
        fetchImpl,
        // count_tokens must not trigger paid rewrites; it reuses cached ones
        compressNew: pathname === '/v1/messages',
      });
      if (changed) out = Buffer.from(JSON.stringify(body));
      for (const r of results) {
        if (r.method !== 'cache' && r.before) log(`${r.method} ${r.lang} ${r.before}→${r.after} tokens${r.failure ? ` (llm: ${r.failure})` : ''}`);
      }
    } catch (err) {
      log(`transform skipped: ${err.message}`); // never block a request
      out = raw;
    }
    forward(req, res, config.upstream, out, log);
  });
  server.cache = cache;
  return server;
}
