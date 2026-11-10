import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureHome, homeDir, liveConfig, VERSION } from '../config.js';
import { createProxy } from '../proxy.js';

export const baseUrl = (cfg) => `http://127.0.0.1:${cfg.port}`;
export const logFile = () => path.join(homeDir(), 'proxy.log');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_LOG_BYTES = 2 * 1024 * 1024;

export async function health(cfg) {
  try {
    const res = await fetch(`${baseUrl(cfg)}/__totoken/health`, { signal: AbortSignal.timeout(800) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

function rotateLog() {
  try {
    if (fs.statSync(logFile()).size > MAX_LOG_BYTES) fs.renameSync(logFile(), `${logFile()}.old`);
  } catch {
    // no log yet
  }
}

// Starts the proxy in the background unless a current one already answers.
// A proxy left over from an older version is replaced.
export async function startDaemon(cfg, self, { quiet = false } = {}) {
  const running = await health(cfg);
  if (running && running.version === VERSION) {
    if (!quiet) console.log(`ToToken já está rodando em ${baseUrl(cfg)}`);
    return true;
  }
  if (running) await stopDaemon(cfg, { quiet: true });
  ensureHome();
  rotateLog();
  const out = fs.openSync(logFile(), 'a', 0o600);
  const child = spawn(process.execPath, [self, 'serve'], { detached: true, windowsHide: true, stdio: ['ignore', out, out], env: process.env });
  child.unref();
  fs.closeSync(out);
  for (let i = 0; i < 40; i++) {
    await sleep(100);
    if (await health(cfg)) {
      if (!quiet) console.log(`ToToken rodando em ${baseUrl(cfg)} (modo ${cfg.mode})`);
      return true;
    }
  }
  if (!quiet) console.error(`ToToken não subiu. Veja ${logFile()}`);
  return false;
}

// Stops the proxy that answers on our port. The pid comes from the proxy itself,
// never from a file, so a stale pid can never kill an unrelated process.
export async function stopDaemon(cfg, { quiet = false } = {}) {
  const running = await health(cfg);
  if (!running || !running.pid) {
    if (!quiet) console.log('ToToken não estava rodando.');
    return false;
  }
  try {
    process.kill(running.pid);
  } catch {
    // already gone
  }
  for (let i = 0; i < 20 && (await health(cfg)); i++) await sleep(100);
  if (!quiet) console.log('ToToken parado.');
  return true;
}

export function serve(cfg) {
  const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
  // port and upstream are fixed at start; everything else follows config.json live
  const live = liveConfig();
  const getConfig = () => ({ ...live(), port: cfg.port, upstream: cfg.upstream });
  const server = createProxy({ config: getConfig, log });
  server.on('error', (err) => {
    log(`não consegui abrir a porta ${cfg.port}: ${err.message}`);
    process.exit(1);
  });
  server.listen(cfg.port, '127.0.0.1', () => log(`ToToken ${VERSION} ouvindo em ${baseUrl(cfg)} → ${cfg.upstream} (modo ${cfg.mode})`));
  // Claude Code depends on this process: log unexpected errors and keep serving.
  process.on('uncaughtException', (err) => log(`erro inesperado: ${err.stack || err.message}`));
  process.on('unhandledRejection', (err) => log(`erro inesperado: ${err?.stack || err}`));
  const shutdown = () => {
    server.cache.flush();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
