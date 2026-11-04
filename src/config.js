import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VERSION = '0.1.0';

export const DEFAULTS = {
  // auto: deterministic pass + LLM rewrite; local: deterministic pass only; off: passthrough
  mode: 'auto',
  port: 8787,
  upstream: 'https://api.anthropic.com',
  rewriterModel: 'claude-haiku-5-5',
  // Below this many free-text characters the LLM rewrite costs more than it saves.
  minCharsForLLM: 160,
  // Translate to concise English (cheaper and as precise); replies stay in the user's language.
  translate: true,
  timeoutMs: 10000,
  maxCacheEntries: 5000,
};

export function homeDir() {
  return process.env.TOTOKEN_HOME || path.join(os.homedir(), '.totoken');
}

export function ensureHome() {
  const dir = homeDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function loadConfig(overrides = {}) {
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(path.join(homeDir(), 'config.json'), 'utf8'));
  } catch {
    // no config file: defaults
  }
  const env = {};
  if (process.env.TOTOKEN_MODE) env.mode = process.env.TOTOKEN_MODE;
  if (process.env.TOTOKEN_PORT) env.port = Number(process.env.TOTOKEN_PORT);
  if (process.env.TOTOKEN_UPSTREAM) env.upstream = process.env.TOTOKEN_UPSTREAM;
  if (process.env.TOTOKEN_REWRITER_MODEL) env.rewriterModel = process.env.TOTOKEN_REWRITER_MODEL;
  if (process.env.TOTOKEN_TRANSLATE) env.translate = process.env.TOTOKEN_TRANSLATE !== '0';
  return { ...DEFAULTS, ...fileCfg, ...env, ...overrides };
}

export function saveConfig(patch) {
  ensureHome();
  const file = path.join(homeDir(), 'config.json');
  let current = {};
  try {
    current = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // new file
  }
  const next = { ...current, ...patch };
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  return next;
}
