import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { DEFAULTS } from '../src/config.js';
import { createProxy } from '../src/proxy.js';
import { RewriteCache } from '../src/store.js';
import { transformBody } from '../src/transform.js';

const PROMPT = 'Olá! Eu gostaria que você revisasse o arquivo src/server.js e encontrasse por que a função handleRequest() às vezes retorna 500 quando o corpo da requisição está vazio. Explique a causa e proponha uma correção mínima, sem mudar a API pública, por favor.';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test('end to end: compresses the human turn, streams the response untouched', async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const body = JSON.parse(data);
      seen.push({ headers: req.headers, body });
      if (body.model === 'claude-haiku-5-5') {
        const ids = [...body.messages[0].content.matchAll(/⟦\d+⟧/g)].map((m) => m[0]);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: `Goal: find why ${ids[1]} in ${ids[0]} returns 500 on empty body.\nOutput: cause + minimal fix; keep public API.` }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start"}\n\n');
      setTimeout(() => res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n'), 20);
    });
  });
  const upPort = await listen(upstream);
  const config = { ...DEFAULTS, upstream: `http://127.0.0.1:${upPort}` };
  const proxy = createProxy({ config, cache: new RewriteCache({ persist: false }) });
  const port = await listen(proxy);
  t.after(() => {
    proxy.close();
    upstream.close();
  });

  const request = {
    model: 'claude-opus-5-5',
    max_tokens: 1000,
    stream: true,
    messages: [{ role: 'user', content: [{ type: 'text', text: '<system-reminder>contexto</system-reminder>' }, { type: 'text', text: PROMPT }] }],
  };
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'secret', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(request),
  });
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.match(text, /message_start[\s\S]*message_stop/);

  const main = seen.find((s) => s.body.model === 'claude-opus-5-5');
  const rewriter = seen.find((s) => s.body.model === 'claude-haiku-5-5');
  assert.ok(rewriter, 'rewriter was called');
  assert.equal(rewriter.headers['x-api-key'], 'secret');
  const blocks = main.body.messages[0].content;
  assert.equal(blocks[0].text, '<system-reminder>contexto</system-reminder>');
  assert.match(blocks[1].text, /^Goal: find why handleRequest\(\) in src\/server\.js returns 500/);
  assert.match(blocks[1].text, /Reply in Brazilian Portuguese\.$/);
  assert.ok(blocks[1].text.length < PROMPT.length);
  assert.equal(main.headers['x-api-key'], 'secret');
});

test('health endpoint and passthrough for other routes', async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path: req.url }));
  });
  const upPort = await listen(upstream);
  const proxy = createProxy({ config: { ...DEFAULTS, upstream: `http://127.0.0.1:${upPort}` }, cache: new RewriteCache({ persist: false }) });
  const port = await listen(proxy);
  t.after(() => {
    proxy.close();
    upstream.close();
  });
  const h = await (await fetch(`http://127.0.0.1:${port}/__totoken/health`)).json();
  assert.equal(h.ok, true);
  const p = await (await fetch(`http://127.0.0.1:${port}/v1/models?limit=1`)).json();
  assert.equal(p.path, '/v1/models?limit=1');
});

test('invalid JSON is forwarded unchanged instead of failing', async (t) => {
  let got = null;
  const upstream = http.createServer((req, res) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      got = d;
      res.writeHead(400);
      res.end('{}');
    });
  });
  const upPort = await listen(upstream);
  const proxy = createProxy({ config: { ...DEFAULTS, upstream: `http://127.0.0.1:${upPort}` }, cache: new RewriteCache({ persist: false }) });
  const port = await listen(proxy);
  t.after(() => {
    proxy.close();
    upstream.close();
  });
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', body: 'not json{' });
  assert.equal(res.status, 400);
  assert.equal(got, 'not json{');
});

test('upstream down returns a clear 502', async (t) => {
  const proxy = createProxy({ config: { ...DEFAULTS, upstream: 'http://127.0.0.1:1' }, cache: new RewriteCache({ persist: false }) });
  const port = await listen(proxy);
  t.after(() => proxy.close());
  const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
  assert.equal(res.status, 502);
  assert.match((await res.json()).error.message, /ToToken proxy/);
});

test('history stays byte-stable and tool results are never touched', async () => {
  const config = { ...DEFAULTS, mode: 'local' };
  const cache = new RewriteCache({ persist: false });
  const turn1 = { messages: [{ role: 'user', content: 'Por favor, rode os testes do projeto.' }] };
  await transformBody(turn1, { config, cache, headers: null });
  const sent1 = turn1.messages[0].content;
  assert.equal(sent1, 'Rode os testes do projeto.');

  // next request resends the ORIGINAL history (as Claude Code keeps it) plus a tool loop
  const turn2 = {
    messages: [
      { role: 'user', content: 'Por favor, rode os testes do projeto.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Por favor veja: 3 falhas' }, { type: 'text', text: 'Por favor, mantenha isto.' }] },
    ],
  };
  await transformBody(turn2, { config, cache, headers: null });
  assert.equal(turn2.messages[0].content, sent1, 'history matches what was sent before');
  assert.equal(turn2.messages[2].content[0].content, 'Por favor veja: 3 falhas');
  assert.equal(turn2.messages[2].content[1].text, 'Por favor, mantenha isto.', 'tool-loop turn is not a new human prompt');
});

test('count_tokens never triggers a rewrite', async () => {
  const config = { ...DEFAULTS, mode: 'local' };
  const cache = new RewriteCache({ persist: false });
  const body = { messages: [{ role: 'user', content: 'Por favor, rode os testes.' }] };
  await transformBody(body, { config, cache, headers: null, compressNew: false });
  assert.equal(body.messages[0].content, 'Por favor, rode os testes.');
});
