import http from 'node:http';
import https from 'node:https';
import { VERSION } from './config.js';
import { rewriterState } from './rewriter.js';
import { RewriteCache } from './store.js';
import { transformBody } from './transform.js';
import { TypedPrompts } from './typed.js';

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
  // keep a path prefix of the upstream (https://gateway/anthropic + /v1/messages)
  const target = new URL(upstream.replace(/\/$/, '') + req.url);
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k)) headers[k] = v;
  headers.host = target.host;
  if (body) headers['content-length'] = Buffer.byteLength(body);
  else if (req.headers['content-length']) headers['content-length'] = req.headers['content-length'];
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

// `config` is a plain object, or a function returning the current one (live reload).
export function createProxy({ config, cache, fetchImpl, log = () => {} }) {
  const getConfig = typeof config === 'function' ? config : () => config;
  cache = cache || new RewriteCache({ maxEntries: getConfig().maxCacheEntries });
  const typed = new TypedPrompts();

  const handle = async (req, res) => {
    const cfg = getConfig();
    const pathname = (req.url || '').split('?')[0];
    if (pathname === '/__totoken/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: VERSION, mode: cfg.mode, pid: process.pid, hooked: typed.hooked, rewriter: rewriterState() }));
      return;
    }
    if (pathname === '/__totoken/prompt' && req.method === 'POST') {
      // the plugin's UserPromptSubmit hook reports what the user just typed
      try {
        typed.add(JSON.parse((await readBody(req)).toString('utf8')).prompt);
      } catch {
        // a malformed report is ignored
      }
      res.writeHead(204);
      res.end();
      return;
    }
    const isMessages = req.method === 'POST' && (pathname === '/v1/messages' || pathname === '/v1/messages/count_tokens');
    if (!isMessages) {
      forward(req, res, cfg.upstream, null, log);
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
        config: cfg,
        cache,
        headers: req.headers,
        fetchImpl,
        typed,
        // count_tokens must not trigger paid rewrites; it reuses what was already sent.
        // Mode "off" still replays history, so turning it off does not break prompt caching.
        compressNew: pathname === '/v1/messages' && cfg.mode !== 'off',
      });
      if (changed) out = Buffer.from(JSON.stringify(body));
      for (const r of results) {
        if (r.method !== 'cache' && r.before) log(`${r.method} ${r.lang} ${r.before}→${r.after} tokens${r.failure ? ` (llm: ${r.failure})` : ''}`);
      }
    } catch (err) {
      log(`transform skipped: ${err.message}`); // never block a request
      out = raw;
    }
    forward(req, res, cfg.upstream, out, log);
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log(`request failed: ${err.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `ToToken proxy: ${err.message}` } }));
    });
  });
  server.on('clientError', (err, socket) => socket.destroy());
  server.cache = cache;
  server.typed = typed;
  return server;
}
