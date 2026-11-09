import fs from 'node:fs';
import { compressText } from '../compressor.js';
import { VERSION } from '../config.js';
import { readStats } from '../store.js';
import { estimateTokens } from '../tokens.js';
import { baseUrl, health, logFile } from './daemon.js';
import { pointedAtProxy, settingsPath } from './settings.js';

export function pct(before, after) {
  return before ? `${Math.round((1 - after / before) * 100)}%` : '0%';
}

export function splitPrompts(file) {
  return fs.readFileSync(file, 'utf8').split(/^---\s*$/m).map((s) => s.trim()).filter(Boolean);
}

function apiHeaders() {
  if (process.env.ANTHROPIC_API_KEY) return { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' };
  return null;
}

export async function preview(cfg, args) {
  const text = args.length ? args.join(' ') : fs.readFileSync(0, 'utf8');
  const headers = apiHeaders();
  if (cfg.mode === 'auto' && !headers && !cfg.rewriterApiKey) console.error('(sem ANTHROPIC_API_KEY: mostrando só a etapa local)\n');
  const r = await compressText(text, { config: cfg, cache: null, headers, record: false });
  console.log(r.text);
  const before = estimateTokens(text);
  const after = estimateTokens(r.text);
  console.error(`\n[${r.method}] ~${before} → ~${after} tokens (${pct(before, after)} a menos, estimativa)`);
}

async function countTokensApi(text, headers) {
  const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: text }] }),
  });
  if (!res.ok) throw new Error(`count_tokens HTTP ${res.status}`);
  return (await res.json()).input_tokens;
}

export async function bench(cfg, args) {
  const useApi = args.includes('--api');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) throw new Error('uso: totoken bench <arquivo> [--api] [--show]');
  const prompts = splitPrompts(file);
  const headers = apiHeaders();
  if (useApi && !headers) throw new Error('--api precisa de ANTHROPIC_API_KEY');
  const count = useApi ? (t) => countTokensApi(t, headers) : async (t) => estimateTokens(t);
  let totalBefore = 0;
  let totalAfter = 0;
  const methods = {};
  for (const [i, p] of prompts.entries()) {
    const r = await compressText(p, { config: cfg, cache: null, headers, record: false });
    const b = await count(p);
    const a = await count(r.text);
    totalBefore += b;
    totalAfter += a;
    methods[r.method] = (methods[r.method] || 0) + 1;
    console.log(`#${i + 1} [${r.method}] ${b} → ${a} (${pct(b, a)})`);
    if (args.includes('--show')) console.log(`   ${r.text.replace(/\n/g, '\n   ')}\n`);
  }
  console.log(`\nTotal: ${totalBefore} → ${totalAfter} tokens (${pct(totalBefore, totalAfter)} a menos) em ${prompts.length} prompts`);
  console.log(`Contagem: ${useApi ? 'exata (count_tokens)' : 'estimativa local'} · métodos: ${JSON.stringify(methods)}`);
}

function tally(rows) {
  const t = { before: 0, after: 0, rwIn: 0, rwOut: 0, methods: {}, failures: {} };
  for (const r of rows) {
    t.before += r.before || 0;
    t.after += r.after || 0;
    t.rwIn += r.rwIn || 0;
    t.rwOut += r.rwOut || 0;
    t.methods[r.method] = (t.methods[r.method] || 0) + 1;
    if (r.failure) t.failures[r.failure] = (t.failures[r.failure] || 0) + 1;
  }
  return t;
}

const list = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ');

export function stats() {
  const rows = readStats();
  if (!rows.length) {
    console.log('Ainda sem dados. Use o Claude Code pelo proxy e volte aqui.');
    return;
  }
  const t = tally(rows);
  console.log(`Prompts comprimidos: ${rows.length}`);
  console.log(`Tokens do seu texto: ~${t.before} → ~${t.after} (${pct(t.before, t.after)} a menos, estimativa)`);
  console.log(`Por método: ${list(t.methods)}`);
  if (t.rwIn || t.rwOut) console.log(`Gasto da reescrita (${rows.filter((r) => r.rwIn).length} chamadas ao modelo pequeno): ${t.rwIn} tokens de entrada, ${t.rwOut} de saída`);
  if (Object.keys(t.failures).length) console.log(`Reescritas que não entraram (valeu a etapa local): ${list(t.failures)}`);
}

// Shows what was actually sent for the most recent prompts.
export function last(args) {
  const n = Math.max(1, Number(args[0]) || 3);
  const rows = readStats().filter((r) => r.sample).slice(-n);
  if (!rows.length) {
    console.log('Ainda não há prompts registrados.');
    return;
  }
  for (const r of rows) {
    console.log(`── ${r.ts} · ${r.method} · ~${r.before} → ~${r.after} tokens (${pct(r.before, r.after)} a menos)${r.failure ? ` · reescrita: ${r.failure}` : ''}`);
    console.log(`Você:    ${r.orig}${r.orig.length >= 80 ? '…' : ''}`);
    console.log(`Enviado: ${r.sample.replace(/\n/g, '\n         ')}${r.sample.length >= 400 ? '…' : ''}\n`);
  }
}

const FAILURE_HELP = {
  'http-401': 'a API recusou a credencial na chamada de reescrita',
  'http-403': 'a credencial não tem permissão para a chamada de reescrita',
  'http-400': 'a API rejeitou o formato da chamada de reescrita',
  'http-404': 'o modelo de reescrita não foi encontrado',
  'http-429': 'limite de uso atingido na chamada de reescrita',
  timeout: 'a reescrita demorou mais que o limite',
  network: 'sem conexão com a API na chamada de reescrita',
};

// Checks every link of the chain and says what to do about the broken one.
export async function doctor(cfg) {
  let problems = 0;
  const ok = (msg) => console.log(`  ok    ${msg}`);
  const bad = (msg, fix) => {
    problems++;
    console.log(`  FALHA ${msg}\n        → ${fix}`);
  };
  console.log(`ToToken ${VERSION} · Node ${process.versions.node}`);
  if (Number(process.versions.node.split('.')[0]) >= 18) ok('Node.js 18 ou mais novo');
  else bad('Node.js antigo', 'instale o Node.js 18 ou mais novo');

  const h = await health(cfg);
  if (!h) bad(`o proxy não responde em ${baseUrl(cfg)}`, `rode "totoken start" e veja ${logFile()}`);
  else if (h.version !== VERSION) bad(`o proxy em execução é da versão ${h.version}`, 'rode "totoken start" para trocá-lo');
  else ok(`proxy rodando em ${baseUrl(cfg)} (modo ${h.mode})`);

  let pointed = false;
  try {
    pointed = pointedAtProxy(cfg);
    if (pointed) ok('o Claude Code está apontado para o proxy');
    else bad(`ANTHROPIC_BASE_URL em ${settingsPath()} não aponta para o proxy`, 'rode "totoken setup" (ou use "totoken run" para uma sessão só)');
  } catch (err) {
    bad(err.message, 'corrija o arquivo de configurações do Claude Code');
  }
  if (pointed && !h) console.log('        Atenção: sem o proxy o Claude Code não conecta. Ligue-o ou rode "totoken remove".');

  try {
    await fetch(cfg.upstream, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    ok(`destino alcançável: ${cfg.upstream}`);
  } catch {
    bad(`não consegui alcançar ${cfg.upstream}`, 'confira a internet ou o valor de "upstream" na configuração');
  }

  const recent = readStats().slice(-50);
  const t = tally(recent);
  const llm = t.methods.llm || 0;
  const failed = Object.entries(t.failures).filter(([k]) => /^(http-|timeout|network|paused)/.test(k));
  if (cfg.mode !== 'auto') {
    ok(`modo ${cfg.mode}: a reescrita com ${cfg.rewriterModel} está desligada`);
  } else if (h?.rewriter?.paused) {
    const why = h.rewriter.lastFailure;
    bad(`reescrita em pausa após falhas seguidas (${why}: ${FAILURE_HELP[why] || 'falha na chamada'})`, 'as regras locais continuam valendo. Se a falha for de credencial, defina TOTOKEN_API_KEY com uma chave de API ou use "totoken mode local"');
  } else if (failed.length && !llm) {
    const [why] = failed[0];
    bad(`nenhuma reescrita deu certo nos últimos prompts (${list(t.failures)})`, `${FAILURE_HELP[why] || 'falha na chamada'}. Defina TOTOKEN_API_KEY com uma chave de API ou use "totoken mode local"`);
  } else if (llm) {
    ok(`reescrita funcionando: ${llm} dos últimos ${recent.length} prompts registrados`);
  } else {
    ok('reescrita ligada; ainda sem prompts longos em português para avaliar');
  }
  console.log(problems ? `\n${problems} problema(s) encontrado(s).` : '\nTudo certo.');
  return problems === 0;
}
