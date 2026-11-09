import './_home.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { compressText, cachedText } from '../src/compressor.js';
import { DEFAULTS } from '../src/config.js';
import { deterministicCompress } from '../src/deterministic.js';
import { detectLanguage } from '../src/detect.js';
import { mask, placeholdersIntact, unmask } from '../src/protect.js';
import { validateRewrite, authHeadersFrom } from '../src/rewriter.js';
import { RewriteCache } from '../src/store.js';
import { estimateTokens } from '../src/tokens.js';

const cfg = (o = {}) => ({ ...DEFAULTS, ...o });
const memCache = () => new RewriteCache({ persist: false });

test('mask/unmask round-trips and protects code, paths, tags, identifiers', () => {
  const text = 'Por favor rode `npm test` em src/app.js, chame getUser() e veja <system-reminder>não mexa</system-reminder> em https://x.dev/a?b=1 com --force e "texto exato".';
  const { masked, pieces } = mask(text);
  for (const p of ['`npm test`', 'src/app.js', 'getUser()', '<system-reminder>não mexa</system-reminder>', 'https://x.dev/a?b=1', '--force', '"texto exato"']) {
    assert.ok(pieces.includes(p) || pieces.some((x) => x.includes(p)), `protected: ${p}`);
    assert.ok(!masked.includes(p), `masked out: ${p}`);
  }
  assert.equal(unmask(masked, pieces), text);
  assert.ok(placeholdersIntact(masked, pieces.length));
});

test('deterministic pass strips filler but keeps meaning words', () => {
  const out = deterministicCompress('Olá Claude! Você poderia por favor criar um teste? Basicamente o usuário pode editar. Obrigado desde já!!!');
  assert.equal(out, 'Criar um teste? O usuário pode editar.');
  assert.equal(deterministicCompress('Hi there! Could you please fix the bug? Thanks in advance.'), 'Fix the bug?');
  assert.equal(deterministicCompress('Oito arquivos falharam.'), 'Oito arquivos falharam.');
});

test('deterministic pass removes repeated sentences', () => {
  assert.equal(deterministicCompress('Não apague os testes existentes. Não apague os testes existentes.'), 'Não apague os testes existentes.');
});

test('language detection', () => {
  assert.equal(detectLanguage('Quero que você crie uma função que não use dependências'), 'pt');
  assert.equal(detectLanguage('Please make the function work with all the files'), 'en');
});

test('token estimate counts accented words as more expensive', () => {
  assert.ok(estimateTokens('não função ação') > estimateTokens('not function action'));
});

test('validateRewrite rejects lost placeholders and growth', () => {
  const masked = 'Crie uma função ⟦0⟧ que leia ⟦1⟧ e devolva um objeto com as chaves certas por favor';
  assert.equal(validateRewrite('Create ⟦0⟧ that reads ⟦1⟧ and returns an object.', masked, 2), null);
  assert.equal(validateRewrite('Create a function that reads a file.', masked, 2), 'placeholders');
  assert.equal(validateRewrite(masked + ' extra extra extra', masked, 2), 'not-smaller');
  assert.equal(validateRewrite('', masked, 2), 'empty');
});

test('auth headers keep only credentials and oauth betas', () => {
  const h = authHeadersFrom({ authorization: 'Bearer t', 'anthropic-beta': 'oauth-2025-04-20,context-1m-2025-08-07', 'x-other': '1' });
  assert.equal(h.authorization, 'Bearer t');
  assert.equal(h['anthropic-beta'], 'oauth-2025-04-20');
  assert.equal(h['x-other'], undefined);
});

function fakeFetch(reply, calls = []) {
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: reply(JSON.parse(init.body)) }] }), { status: 200 });
  };
}

const LONG_PT = 'Olá! Eu gostaria que você criasse uma função chamada parse_config no arquivo src/config.js que leia o arquivo de configuração, valide os campos obrigatórios e devolva um objeto com valores padrão quando algum campo estiver faltando. Não use dependências externas, por favor.';

test('LLM rewrite is used, placeholders restored, reply-language hint added', async () => {
  const calls = [];
  const fetchImpl = fakeFetch((body) => {
    const masked = body.messages[0].content;
    const ids = [...masked.matchAll(/⟦\d+⟧/g)].map((m) => m[0]);
    return `Goal: create ${ids[0]} in ${ids[1]}: read config, validate required fields, return object with defaults for missing ones.\nConstraints: no external deps.`;
  }, calls);
  const r = await compressText(LONG_PT, { config: cfg(), cache: memCache(), headers: { 'x-api-key': 'k' }, fetchImpl, record: false });
  assert.equal(r.method, 'llm');
  assert.match(r.text, /parse_config/);
  assert.match(r.text, /src\/config\.js/);
  assert.match(r.text, /Reply in Brazilian Portuguese\.$/);
  assert.ok(r.after < r.before);
  assert.equal(calls[0].body.model, 'claude-haiku-5-5');
  assert.equal(calls[0].body.thinking.type, 'disabled');
  assert.equal(calls[0].headers['x-api-key'], 'k');
});

test('bad LLM output falls back to the deterministic result', async () => {
  const fetchImpl = fakeFetch(() => 'Sure! Here is the function you asked for: function parse() {}');
  const r = await compressText(LONG_PT, { config: cfg(), cache: memCache(), headers: { 'x-api-key': 'k' }, fetchImpl, record: false });
  assert.equal(r.method, 'local');
  assert.equal(r.failure, 'placeholders');
  assert.match(r.text, /parse_config/);
});

test('network failure falls back safely', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed');
  };
  const r = await compressText(LONG_PT, { config: cfg(), cache: memCache(), headers: { 'x-api-key': 'k' }, fetchImpl, record: false });
  assert.equal(r.method, 'local');
  assert.equal(r.failure, 'network');
});

test('results are cached and history lookups are stable', async () => {
  const cache = memCache();
  let n = 0;
  const fetchImpl = async (...a) => {
    n++;
    return fakeFetch((b) => `Create ${[...b.messages[0].content.matchAll(/⟦\d+⟧/g)].map((m) => m[0]).join(' ')} config parser, defaults, no deps.`)(...a);
  };
  const opts = { config: cfg(), cache, headers: { 'x-api-key': 'k' }, fetchImpl, record: false };
  const a = await compressText(LONG_PT, opts);
  const b = await compressText(LONG_PT, opts);
  assert.equal(n, 1);
  assert.equal(b.method, 'cache');
  assert.equal(a.text, b.text);
  assert.equal(cachedText(LONG_PT, { config: cfg(), cache }), a.text);
  assert.equal(cachedText('never seen', { config: cfg(), cache }), 'never seen');
});

test('!raw bypasses compression; off mode passes through', async () => {
  const r = await compressText('!raw Por favor mantenha isto', { config: cfg(), cache: memCache(), record: false });
  assert.equal(r.text, 'Por favor mantenha isto');
  const off = await compressText('Por favor mantenha isto', { config: cfg({ mode: 'off' }), cache: memCache(), record: false });
  assert.equal(off.text, 'Por favor mantenha isto');
});

test('short prompts skip the LLM call', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    throw new Error('should not call');
  };
  const r = await compressText('Por favor rode os testes.', { config: cfg(), cache: memCache(), headers: { 'x-api-key': 'k' }, fetchImpl, record: false });
  assert.equal(called, false);
  assert.equal(r.text, 'Rode os testes.');
});

test('text that cannot shrink is returned unchanged', async () => {
  const code = '```js\nconst a = 1;\n```';
  const r = await compressText(code, { config: cfg(), cache: memCache(), record: false });
  assert.equal(r.text, code);
  assert.equal(r.method, 'none');
});
