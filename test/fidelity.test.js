// Guards for the two promises of the plugin: never change what the user meant,
// and never change a message that was already sent.
import './_home.js';
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { cachedText, compressText } from '../src/compressor.js';
import { DEFAULTS } from '../src/config.js';
import { deterministicCompress } from '../src/deterministic.js';
import { mask, unmask } from '../src/protect.js';
import { createProxy } from '../src/proxy.js';
import { llmRewrite, numbersKept, resetRewriterState, rewriterState, validateRewrite } from '../src/rewriter.js';
import { RewriteCache } from '../src/store.js';
import { transformBody } from '../src/transform.js';

const cfg = (o = {}) => ({ ...DEFAULTS, ...o });
const memCache = () => new RewriteCache({ persist: false });
const local = (text) => {
  const { masked, pieces } = mask(text);
  return unmask(deterministicCompress(masked), pieces);
};

test('sentences that only look like filler keep their meaning', () => {
  for (const text of [
    'Pode ser que o bug esteja no cache.',
    'Você pode usar qualquer lib. Você consegue terminar hoje?',
    'Consegue rodar no Windows?',
    'O que você consegue fazer com isso?',
    'Como você pode ver, o teste falha.',
    'O usuário é obrigado a preencher o campo.',
    'Valeu a pena migrar para hooks?',
    'O que você sabe?',
    'E aí o servidor cai depois de 3 requisições.',
    'Se possível, adicione um teste.',
    'What would you recommend here?',
    'How can you tell if the cache is stale?',
    'I need to know why it fails.',
    'Thanks to the cache it is fast.',
    'Oito arquivos falharam.',
  ]) {
    assert.equal(local(text), text);
  }
});

test('code, commands and pasted data come out byte for byte', () => {
  for (const text of [
    'npm install foo',
    '.env',
    'use std::vector e Foo::bar',
    'a: b, c:d',
    'const x = { a: 1 };',
    '    at handle (server.js:10:5)',
    'Error: Cannot find module \'x\'',
    'chave:valor,outra:coisa',
    '# Título\n\n\n- item um\n\t- sub item',
  ]) {
    assert.equal(local(text), text);
  }
  const paste = 'Por favor, veja o erro abaixo:\n\nnpm ERR! code ELIFECYCLE\n  at Object.<anonymous> (/app/index.js:3:1)\nexport DEBUG=1\n\nindex.js\nutils.js';
  assert.equal(local(paste), 'Veja o erro abaixo:\n\nnpm ERR! code ELIFECYCLE\n  at Object.<anonymous> (/app/index.js:3:1)\nexport DEBUG=1\n\nindex.js\nutils.js');
});

test('filler is still removed where it is safe', () => {
  assert.equal(local('Oi, tudo bem? Você pode me explicar o erro? Valeu!'), 'Explicar o erro?');
  assert.equal(local('Bom dia! Quero que você refatore o módulo, por favor.'), 'Refatore o módulo.');
  assert.equal(local('- por favor, rode os testes\n- obrigado!'), '- rode os testes');
  assert.equal(local('Can you help me fix the login bug? Thank you!'), 'Fix the login bug?');
  assert.equal(local('Oi! Por favor, liste os arquivos, valeu!'), 'Liste os arquivos');
});

test('new protected spans', () => {
  const text = 'Veja .env, report-2.pdf, $HOME, ${NODE_ENV}, std::vector, v22.4.0, a1b2c3d4e5 e \'texto exato\' de dev@x.com';
  const { masked, pieces } = mask(text);
  for (const p of ['.env', 'report-2.pdf', '$HOME', '${NODE_ENV}', 'std::vector', 'v22.4.0', 'a1b2c3d4e5', "'texto exato'", 'dev@x.com']) {
    assert.ok(pieces.includes(p), `protected: ${p}`);
  }
  assert.equal(unmask(masked, pieces), text);
});

test('text containing placeholder brackets is left alone', async () => {
  const text = 'Por favor, explique o que significa ⟦0⟧ neste arquivo, obrigado!';
  const r = await compressText(text, { config: cfg(), cache: memCache(), record: false });
  assert.equal(r.text, text);
});

test('a prompt that is only filler is not sent empty', async () => {
  const r = await compressText('Muito obrigado!', { config: cfg({ mode: 'local' }), cache: memCache(), record: false });
  assert.equal(r.text, 'Muito obrigado!');
});

test('rewrites that drop or change a number are rejected', () => {
  assert.ok(numbersKept('tente 3 vezes com 1,5s e 10 mil itens', 'retry 3 times, 1.5s, 10,000 items'));
  assert.ok(!numbersKept('tente 3 vezes', 'retry 5 times'));
  assert.ok(!numbersKept('porta 8080', 'port 80800'));
  assert.equal(validateRewrite('Retry a few times on ⟦0⟧ when the server answers with an error.', 'Tente no máximo 3 vezes em ⟦0⟧ quando o servidor responder com erro, por favor mesmo', 1), 'numbers');
});

const LONG_PT = 'Eu estou com um problema no módulo de pagamentos: quando o cliente tenta pagar duas vezes seguidas o sistema cria dois pedidos iguais. Descubra onde falta a verificação e proponha a correção mais simples que resolver, sem mudar o banco de dados.';
const LONG_EN = 'I have a problem in the payments module: when the customer tries to pay twice in a row the system creates two identical orders. Find where the check is missing and propose the simplest fix that works, without changing the database schema.';
const okFetch = (calls) => async (url, init) => {
  calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ stop_reason: 'end_turn', usage: { input_tokens: 300, output_tokens: 30 }, content: [{ type: 'text', text: 'Goal: find the missing duplicate-payment check; propose simplest fix.\nConstraints: no database changes.' }] }), { status: 200 });
};

test('the paid rewrite is skipped where it cannot pay off', async () => {
  resetRewriterState();
  const calls = [];
  const base = { cache: null, headers: { 'x-api-key': 'k' }, fetchImpl: okFetch(calls), record: false };
  await compressText(LONG_EN, { ...base, config: cfg() });
  assert.equal(calls.length, 0, 'English prompt: local rules only');
  await compressText(LONG_PT, { ...base, config: cfg(), model: 'claude-haiku-5-5' });
  assert.equal(calls.length, 0, 'request for a Haiku model');
  await compressText(LONG_PT, { ...base, config: cfg({ maxCharsForLLM: 100 }) });
  assert.equal(calls.length, 0, 'text above the size window');
  const r = await compressText(LONG_PT, { ...base, config: cfg(), model: 'claude-opus-5-5' });
  assert.equal(calls.length, 1);
  assert.equal(r.method, 'llm');
  await compressText(LONG_EN, { ...base, config: cfg({ rewriteEnglish: true }) });
  assert.equal(calls.length, 2, 'English rewrite is opt-in');
});

test('a dedicated rewriter key replaces the intercepted credentials', async () => {
  resetRewriterState();
  const calls = [];
  await compressText(LONG_PT, { config: cfg({ rewriterApiKey: 'own-key' }), cache: null, headers: { authorization: 'Bearer oauth' }, fetchImpl: okFetch(calls), record: false });
  assert.equal(calls[0].headers['x-api-key'], 'own-key');
  assert.equal(calls[0].headers.authorization, undefined);
});

test('the rewriter pauses after repeated transport failures', async () => {
  resetRewriterState();
  let n = 0;
  const fetchImpl = async () => {
    n++;
    return new Response('{}', { status: 401 });
  };
  const opts = { config: cfg(), headers: { authorization: 'Bearer t' }, fetchImpl };
  for (let i = 0; i < 3; i++) assert.equal((await llmRewrite('texto ⟦0⟧', 1, opts)).reason, 'http-401');
  assert.equal(rewriterState().paused, true);
  const r = await llmRewrite('texto ⟦0⟧', 1, opts);
  assert.match(r.reason, /^paused/);
  assert.equal(n, 3, 'no call while paused');
  resetRewriterState();
});

test('history is replayed exactly after a mode change, in mode off and after a restart', async () => {
  resetRewriterState();
  const cache = memCache();
  const first = { model: 'claude-opus-5-5', messages: [{ role: 'user', content: LONG_PT }] };
  await transformBody(first, { config: cfg(), cache, headers: { 'x-api-key': 'k' }, fetchImpl: okFetch([]) });
  const sent = first.messages[0].content;
  assert.match(sent, /^Goal:/);

  for (const mode of ['local', 'off', 'auto']) {
    const later = { messages: [{ role: 'user', content: LONG_PT }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'Continue.' }] };
    await transformBody(later, { config: cfg({ mode, translate: false, rewriterModel: 'other' }), cache, headers: null, compressNew: mode !== 'off' });
    assert.equal(later.messages[0].content, sent, `mode ${mode}`);
  }
  // a restarted proxy loads the same entries from disk
  const reloaded = memCache();
  for (const [k, v] of JSON.parse(JSON.stringify([...cache.map]))) reloaded.map.set(k, v);
  assert.equal(cachedText(LONG_PT, { cache: reloaded }), sent);
});

test('a prompt sent unchanged stays unchanged when it is seen again', async () => {
  resetRewriterState();
  const cache = memCache();
  const failing = async () => {
    throw new TypeError('fetch failed');
  };
  const text = 'Descubra onde falta a verificação de pagamento duplicado no módulo de pedidos e proponha a correção mais simples que resolver o problema sem mudar o banco de dados nem a API pública do serviço.';
  const a = await compressText(text, { config: cfg(), cache, headers: { 'x-api-key': 'k' }, fetchImpl: failing, record: false });
  assert.equal(a.text, text);
  const b = await compressText(text, { config: cfg(), cache, headers: { 'x-api-key': 'k' }, fetchImpl: okFetch([]), record: false });
  assert.equal(b.text, text, 'the retry does not get a different text');
  resetRewriterState();
});

test('mode off through the proxy still replays history and follows live config', async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      seen.push(JSON.parse(d));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const config = cfg({ mode: 'local', upstream: `http://127.0.0.1:${upstream.address().port}` });
  const proxy = createProxy({ config: () => config, cache: memCache() });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  t.after(() => {
    proxy.close();
    upstream.close();
  });
  const post = (messages) => fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tools: [{ name: 'Bash' }], messages }) });
  const q1 = 'Por favor, rode os testes do projeto.';
  await post([{ role: 'user', content: q1 }]);
  config.mode = 'off';
  await post([{ role: 'user', content: q1 }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'Por favor, rode de novo.' }]);
  assert.equal(seen[0].messages[0].content, 'Rode os testes do projeto.');
  assert.equal(seen[1].messages[0].content, 'Rode os testes do projeto.', 'history kept');
  assert.equal(seen[1].messages[2].content, 'Por favor, rode de novo.', 'new prompt untouched in off mode');
});

test('large and hostile inputs are handled quickly', async () => {
  const big = ('<a> texto, texto, ' + 'palavra '.repeat(40) + '\n').repeat(60); // under maxChars
  const huge = 'por favor '.repeat(5000); // over maxChars
  const oneLine = 'bla, '.repeat(3000);
  const started = Date.now();
  for (const text of [big.slice(0, 19000), huge, oneLine]) {
    const r = await compressText(text, { config: cfg({ mode: 'local' }), cache: null, record: false });
    assert.ok(r.text.length > 0);
  }
  assert.equal((await compressText(huge, { config: cfg({ mode: 'local' }), cache: null, record: false })).text, huge);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started}ms`);
});

test('politeness words that are the subject of the sentence are kept', () => {
  for (const text of [
    'Não use obrigado como nome de variável, use thanks no campo.',
    'A mensagem diz obrigado ao usuário; traduza valeu para thanks',
    'Explique o que significa por favor em inglês',
    'Oi é o nome da operadora.',
    'Bom dia é a string esperada no output.',
    'The word please is not allowed in the label.',
    'Can you delete the prod database? I am asking, do not do it.',
    'I want to know whether I need you to sign off.',
    'corrija o teste, corrija o teste de integração também',
    'explique x ?? y e !!flag em JS',
    'Teste A falhou em main. Teste A falhou em main? Responda.',
    'use a ? b : c aqui',
  ]) {
    assert.equal(local(text), text);
  }
});

test('whitespace runs and long repetitive lines do not stall the proxy', () => {
  const started = Date.now();
  local(`a${' '.repeat(20000)}b`);
  local(`por favor veja${' '.repeat(1900)}isto, obrigado`);
  local('palavra outra coisa '.repeat(900));
  local(`linha um\n${'\n'.repeat(5000)}por favor, linha dois`);
  local('a.'.repeat(9000));
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started}ms`);
});

test('raw: sends a prompt untouched and needs a space after it', async () => {
  const opts = { config: cfg({ mode: 'local' }), cache: memCache(), record: false };
  assert.equal((await compressText('raw: Por favor mantenha isto', opts)).text, 'Por favor mantenha isto');
  assert.equal((await compressText('!rawData está quebrado no parser, por favor veja', opts)).text, '!rawData está quebrado no parser, veja');
});

test('no reply-language hint when the user already chose a language', async () => {
  resetRewriterState();
  const text = `${LONG_PT} Escreva a mensagem de commit em inglês.`;
  const r = await compressText(text, { config: cfg(), cache: null, headers: { 'x-api-key': 'k' }, fetchImpl: okFetch([]), record: false });
  assert.equal(r.method, 'llm');
  assert.doesNotMatch(r.text, /Reply in Brazilian Portuguese/);
});

test('only prompts the user typed are compressed once the hook reports them', async () => {
  const { TypedPrompts } = await import('../src/typed.js');
  const config = cfg({ mode: 'local' });
  const run = async (typed, content, extra = {}) => {
    const body = { messages: [{ role: 'user', content }], ...extra };
    await transformBody(body, { config, cache: memCache(), headers: null, typed });
    return body.messages[0].content;
  };
  const harness = 'Please write a short title for this conversation, thanks.';
  const mine = 'Por favor, rode os testes do projeto.';

  const typed = new TypedPrompts();
  assert.equal(await run(typed, harness), harness, 'no hook yet and no tools: a side request');
  assert.equal(await run(typed, mine, { tools: [{ name: 'Bash' }] }), 'Rode os testes do projeto.', 'no hook yet: main-loop requests are compressed');

  typed.add(mine);
  assert.equal(await run(typed, mine), 'Rode os testes do projeto.');
  assert.equal(await run(typed, `<context>x</context>\n${mine}`), '<context>x</context>\nRode os testes do projeto.', 'typed prompt wrapped in context');
  assert.equal(await run(typed, harness, { tools: [{ name: 'Bash' }] }), harness, 'text the user did not type');
});

test('the hook endpoint registers a prompt and an upstream path prefix is kept', async (t) => {
  const seen = [];
  const upstream = http.createServer((req, res) => {
    let d = '';
    req.on('data', (c) => (d += c));
    req.on('end', () => {
      seen.push({ url: req.url, body: JSON.parse(d) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const proxy = createProxy({ config: cfg({ mode: 'local', upstream: `http://127.0.0.1:${upstream.address().port}/gateway` }), cache: memCache() });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  t.after(() => {
    proxy.close();
    upstream.close();
  });
  const url = `http://127.0.0.1:${proxy.address().port}`;
  const typedPrompt = 'Por favor, rode os testes do projeto.';
  const post = (content) => fetch(`${url}/v1/messages`, { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content }] }) });
  assert.equal((await fetch(`${url}/__totoken/prompt`, { method: 'POST', body: JSON.stringify({ prompt: typedPrompt }) })).status, 204);
  assert.equal((await (await fetch(`${url}/__totoken/health`)).json()).hooked, true);
  await post(typedPrompt);
  await post('Por favor, resuma a conversa acima.');
  assert.equal(seen[0].url, '/gateway/v1/messages');
  assert.equal(seen[0].body.messages[0].content, 'Rode os testes do projeto.');
  assert.equal(seen[1].body.messages[0].content, 'Por favor, resuma a conversa acima.');
});
