#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeDir, loadConfig, MODES, saveConfig, VERSION } from '../src/config.js';
import { baseUrl, health, serve, startDaemon, stopDaemon } from '../src/cli/daemon.js';
import { bench, doctor, last, preview, stats } from '../src/cli/report.js';
import { install, uninstall } from '../src/cli/settings.js';
import { claudeCli, hasClaudeCli, simulate } from '../src/cli/simulate.js';

const SELF = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SELF), '..');
const PLUGIN = 'totoken@totoken-translator';

const help = (cfg) => `ToToken Translator ${VERSION}: compressão automática de prompts para o Claude.

Uso: totoken <comando>

  setup              Instala tudo: liga o proxy, registra o plugin e aponta o Claude Code para ele
  remove             Desfaz o setup
  doctor             Confere cada etapa e diz o que fazer se algo estiver quebrado
  status             Mostra se o proxy está rodando
  stats              Economia acumulada
  last [n]           Mostra o que foi enviado de fato nos últimos prompts
  mode <auto|local|off>  Troca o modo (vale na hora, sem reiniciar)
  preview <texto>    Mostra como um prompt seria comprimido (lê stdin se vazio)
  bench <arquivo>    Mede a economia em prompts separados por linhas "---" (--api: contagem exata, --show)
  simulate [--compare] [--file f]  Conversa de teste com o Claude pelo proxy
  run [-- cmd ...]   Sobe o proxy e abre o Claude Code por ele só nesta sessão (padrão: claude)
  start | stop | restart   Controla o proxy em segundo plano
  cache-clear        Esquece as reescritas guardadas

Modos: auto = regras locais + reescrita com ${cfg.rewriterModel}; local = só regras locais (custo zero); off = não comprime nada novo.
Comece um prompt com "raw:" para enviá-lo sem compressão.`;

async function setup(cfg) {
  console.log('1/3 Ligando o proxy...');
  if (!(await startDaemon(cfg, SELF))) process.exit(1);
  console.log('2/3 Registrando o plugin no Claude Code...');
  let plugin = false;
  if (hasClaudeCli()) {
    claudeCli(['plugin', 'marketplace', 'add', ROOT]);
    plugin = claudeCli(['plugin', 'install', PLUGIN]);
  }
  if (!plugin) {
    // Without the plugin's hooks nobody restarts the proxy, so do not point Claude
    // Code at it permanently: that would break Claude Code after a reboot.
    console.log(`Não consegui registrar o plugin. Use "node ${SELF} run" para abrir o Claude Code pelo proxy.`);
    return;
  }
  console.log('3/3 Apontando o Claude Code para o proxy...');
  install(cfg);
  console.log('\nPronto. Abra o Claude Code normalmente: todo prompt passa pelo ToToken.');
  console.log(`Conferir: node ${SELF} doctor · desfazer: node ${SELF} remove`);
}

async function removeAll(cfg) {
  uninstall(cfg); // first, so Claude Code never points at a stopped proxy
  if (hasClaudeCli()) {
    claudeCli(['plugin', 'uninstall', PLUGIN]);
    claudeCli(['plugin', 'marketplace', 'remove', 'totoken-translator']);
  }
  await stopDaemon(cfg);
  console.log('ToToken removido. O Claude Code volta a falar direto com a API.');
}

async function run(cfg, args) {
  if (!(await startDaemon(cfg, SELF, { quiet: true }))) process.exit(1);
  const dash = args.indexOf('--');
  const cmd = dash >= 0 ? args.slice(dash + 1) : args;
  const [bin, ...rest] = cmd.length ? cmd : ['claude'];
  const child = spawn(bin, rest, { stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, ANTHROPIC_BASE_URL: baseUrl(cfg) } });
  child.on('error', (err) => {
    console.error(`totoken: não consegui abrir "${bin}": ${err.message}`);
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const cfg = loadConfig();
  switch (cmd) {
    case 'serve': return serve(cfg);
    case 'start': return void (await startDaemon(cfg, SELF));
    case 'stop': return void (await stopDaemon(cfg));
    case 'restart':
      await stopDaemon(cfg, { quiet: true });
      return void (await startDaemon(cfg, SELF));
    case 'ensure': {
      // Called by the plugin hooks: must stay silent and never fail the hook.
      const quiet = args.includes('--quiet');
      try {
        await startDaemon(cfg, SELF, { quiet });
      } catch (err) {
        if (!quiet) throw err;
      }
      return;
    }
    case 'hook': {
      // UserPromptSubmit hook: keep the proxy up and tell it what the user typed.
      // Anything printed here would be added to the conversation, so stay silent.
      try {
        const { prompt } = JSON.parse(fs.readFileSync(0, 'utf8'));
        if (await startDaemon(cfg, SELF, { quiet: true })) {
          await fetch(`${baseUrl(cfg)}/__totoken/prompt`, { method: 'POST', body: JSON.stringify({ prompt }), signal: AbortSignal.timeout(2000) });
        }
      } catch {
        // never fail the user's prompt because of the hook
      }
      return;
    }
    case 'status': {
      const h = await health(cfg);
      if (!h) return console.log('Parado.');
      console.log(`Rodando em ${baseUrl(cfg)} (v${h.version}, modo ${h.mode})`);
      if (h.rewriter?.paused) console.log(`Reescrita em pausa após falhas seguidas (${h.rewriter.lastFailure}). Rode "totoken doctor".`);
      return;
    }
    case 'doctor': return void (process.exitCode = (await doctor(cfg)) ? 0 : 1);
    case 'run': return run(cfg, args);
    case 'preview': return preview(cfg, args);
    case 'bench': return bench(cfg, args);
    case 'simulate':
      if (!(await startDaemon(cfg, SELF, { quiet: true }))) process.exit(1);
      return simulate(cfg, args);
    case 'stats': return stats();
    case 'last': return last(args);
    case 'mode': {
      if (!MODES.includes(args[0])) throw new Error(`uso: totoken mode <${MODES.join('|')}>`);
      saveConfig({ mode: args[0] });
      console.log(`Modo: ${args[0]}. Vale a partir do próximo prompt.`);
      return;
    }
    case 'setup': return setup(cfg);
    case 'remove': return removeAll(cfg);
    case 'install': return install(cfg);
    case 'uninstall': return uninstall(cfg);
    case 'cache-clear': {
      fs.rmSync(path.join(homeDir(), 'cache.json'), { force: true });
      if (await health(cfg)) {
        await stopDaemon(cfg, { quiet: true });
        await startDaemon(cfg, SELF, { quiet: true });
      }
      console.log('Cache limpo.');
      return;
    }
    case '--version':
    case '-v':
      return console.log(VERSION);
    default:
      console.log(help(cfg));
  }
}

main().catch((err) => {
  console.error(`totoken: ${err.message}`);
  process.exit(1);
});
