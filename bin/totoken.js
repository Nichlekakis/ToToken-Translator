#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compressText } from '../src/compressor.js';
import { ensureHome, homeDir, loadConfig, saveConfig, VERSION } from '../src/config.js';
import { createProxy } from '../src/proxy.js';
import { RewriteCache, readStats } from '../src/store.js';
import { estimateTokens } from '../src/tokens.js';

const SELF = fileURLToPath(import.meta.url);
const pidFile = () => path.join(homeDir(), 'proxy.pid');
const logFile = () => path.join(homeDir(), 'proxy.log');
const baseUrl = (cfg) => `http://127.0.0.1:${cfg.port}`;

const HELP = `ToToken Translator ${VERSION}: compressão automática de prompts para o Claude.

Uso: totoken <comando>

  run [-- cmd ...]   Sobe o proxy e abre o Claude Code passando por ele (padrão: claude)
  start | stop       Liga ou desliga o proxy em segundo plano
  status             Mostra se o proxy está rodando
  ensure             Liga o proxy se ainda não estiver rodando (usado pelo hook do plugin)
  preview <texto>    Mostra como um prompt seria comprimido (lê stdin se vazio)
  bench <arquivo>    Mede a economia em prompts separados por linhas "---" (--api: contagem exata)
  stats              Economia acumulada
  mode <auto|local|off>  Troca o modo de compressão
  install | uninstall    Grava ou remove ANTHROPIC_BASE_URL em ~/.claude/settings.json
  serve              Roda o proxy em primeiro plano

Modos: auto = regras locais + reescrita com ${loadConfig().rewriterModel}; local = só regras locais (custo zero); off = passa direto.
Comece um prompt com "!raw" para enviá-lo sem compressão.`;

async function health(cfg) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 800);
    const res = await fetch(`${baseUrl(cfg)}/__totoken/health`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function startDaemon(cfg, quiet = false) {
  if (await health(cfg)) {
    if (!quiet) console.log(`ToToken já está rodando em ${baseUrl(cfg)}`);
    return true;
  }
  ensureHome();
  const out = fs.openSync(logFile(), 'a');
  const child = spawn(process.execPath, [SELF, 'serve'], { detached: true, stdio: ['ignore', out, out], env: process.env });
  child.unref();
  fs.writeFileSync(pidFile(), String(child.pid));
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    if (await health(cfg)) {
      if (!quiet) console.log(`ToToken rodando em ${baseUrl(cfg)} (modo ${cfg.mode})`);
      return true;
    }
  }
  console.error(`ToToken não subiu. Veja ${logFile()}`);
  return false;
}

function stopDaemon() {
  try {
    const pid = Number(fs.readFileSync(pidFile(), 'utf8'));
    process.kill(pid);
    fs.unlinkSync(pidFile());
    console.log('ToToken parado.');
  } catch {
    console.log('ToToken não estava rodando.');
  }
}

function serve(cfg) {
  const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
  const server = createProxy({ config: cfg, log });
  server.listen(cfg.port, '127.0.0.1', () => log(`ToToken ${VERSION} ouvindo em ${baseUrl(cfg)} → ${cfg.upstream} (modo ${cfg.mode})`));
  const shutdown = () => {
    server.cache.flush();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

function apiHeaders() {
  if (process.env.ANTHROPIC_API_KEY) return { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' };
  return null;
}

async function readInput(args) {
  if (args.length) return args.join(' ');
  return fs.readFileSync(0, 'utf8');
}

async function preview(cfg, args) {
  const text = await readInput(args);
  const headers = apiHeaders();
  if (cfg.mode === 'auto' && !headers) console.error('(sem ANTHROPIC_API_KEY: mostrando só a etapa local)\n');
  const r = await compressText(text, { config: cfg, cache: null, headers, record: false });
  console.log(r.text);
  const before = estimateTokens(text);
  const after = estimateTokens(r.text);
  console.error(`\n[${r.method}] ~${before} → ~${after} tokens (${pct(before, after)} a menos, estimativa)`);
}

function pct(before, after) {
  return before ? `${Math.round((1 - after / before) * 100)}%` : '0%';
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

async function bench(cfg, args) {
  const useApi = args.includes('--api');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) throw new Error('uso: totoken bench <arquivo> [--api]');
  const prompts = fs.readFileSync(file, 'utf8').split(/^---\s*$/m).map((s) => s.trim()).filter(Boolean);
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

function stats() {
  const rows = readStats();
  if (!rows.length) {
    console.log('Ainda sem dados. Use o Claude Code pelo proxy e volte aqui.');
    return;
  }
  let before = 0;
  let after = 0;
  const methods = {};
  for (const r of rows) {
    before += r.before || 0;
    after += r.after || 0;
    methods[r.method] = (methods[r.method] || 0) + 1;
  }
  console.log(`Prompts comprimidos: ${rows.length}`);
  console.log(`Tokens do seu texto: ~${before} → ~${after} (${pct(before, after)} a menos, estimativa)`);
  console.log(`Por método: ${Object.entries(methods).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const fails = rows.filter((r) => r.failure);
  if (fails.length) console.log(`Reescritas recusadas ou com falha (usou a etapa local): ${fails.length}`);
}

function settingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function install(cfg, remove = false) {
  const file = settingsPath();
  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.copyFileSync(file, `${file}.totoken-backup`);
  } catch {
    // new settings file
  }
  settings.env = settings.env || {};
  if (remove) {
    if (settings.env.ANTHROPIC_BASE_URL === baseUrl(cfg)) delete settings.env.ANTHROPIC_BASE_URL;
  } else {
    const current = settings.env.ANTHROPIC_BASE_URL;
    if (current && current !== baseUrl(cfg)) {
      saveConfig({ upstream: current });
      console.log(`Upstream anterior preservado: ${current}`);
    }
    settings.env.ANTHROPIC_BASE_URL = baseUrl(cfg);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  console.log(remove ? 'ANTHROPIC_BASE_URL removido.' : `Claude Code agora usa ${baseUrl(cfg)}. O hook do plugin liga o proxy em cada sessão.`);
}

async function run(cfg, args) {
  if (!(await startDaemon(cfg, true))) process.exit(1);
  const dash = args.indexOf('--');
  const cmd = dash >= 0 ? args.slice(dash + 1) : args;
  const [bin, ...rest] = cmd.length ? cmd : ['claude'];
  const child = spawn(bin, rest, { stdio: 'inherit', env: { ...process.env, ANTHROPIC_BASE_URL: baseUrl(cfg) } });
  child.on('exit', (code) => process.exit(code ?? 0));
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const cfg = loadConfig();
  switch (cmd) {
    case 'serve': return serve(cfg);
    case 'start': return void (await startDaemon(cfg));
    case 'ensure': return void (await startDaemon(cfg, args.includes('--quiet')));
    case 'stop': return stopDaemon();
    case 'status': {
      const h = await health(cfg);
      console.log(h ? `Rodando em ${baseUrl(cfg)} (v${h.version}, modo ${h.mode})` : 'Parado.');
      return;
    }
    case 'run': return run(cfg, args);
    case 'preview': return preview(cfg, args);
    case 'bench': return bench(cfg, args);
    case 'stats': return stats();
    case 'mode': {
      if (!['auto', 'local', 'off'].includes(args[0])) throw new Error('uso: totoken mode <auto|local|off>');
      saveConfig({ mode: args[0] });
      console.log(`Modo: ${args[0]}. Reinicie o proxy (totoken stop && totoken start) para aplicar.`);
      return;
    }
    case 'install': return install(cfg);
    case 'uninstall': return install(cfg, true);
    case 'cache-clear': {
      fs.rmSync(path.join(homeDir(), 'cache.json'), { force: true });
      console.log('Cache limpo.');
      return;
    }
    default:
      console.log(HELP);
  }
}

main().catch((err) => {
  console.error(`totoken: ${err.message}`);
  process.exit(1);
});
