import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const VERSION = '0.2.0';
export const MODES = ['auto', 'local', 'off'];
export const DEFAULT_UPSTREAM = 'https://api.anthropic.com';

export const DEFAULTS = {
  // auto: local rules + LLM rewrite; local: local rules only; off: nothing new is compressed
  mode: 'auto',
  port: 8787,
  upstream: DEFAULT_UPSTREAM,
  rewriterModel: 'claude-haiku-5-5',
  // Optional API key used only for the rewrite call. Empty: reuse the credentials
  // of the intercepted request.
  rewriterApiKey: '',
  // Free-text size window (characters) for the LLM rewrite. Below it the rewrite
  // costs more than it saves; above it the text is a paste, not a typed prompt.
  minCharsForLLM: 160,
  maxCharsForLLM: 6000,
  // Prompts longer than this are forwarded untouched.
  maxChars: 20000,
  // Translate to concise English (cheaper and as precise); replies stay in the user's language.
  translate: true,
  // English prompts get only the local rules by default: there is no translation
  // gain, and most English text Claude Code sends is written by the harness.
  rewriteEnglish: false,
  // Keep a short sample of each prompt in stats.jsonl (used by `last` and `simulate`).
  logSamples: true,
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

export function configFile() {
  return path.join(homeDir(), 'config.json');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function envConfig() {
  const e = process.env;
  const env = {};
  if (e.TOTOKEN_MODE) env.mode = e.TOTOKEN_MODE;
  if (e.TOTOKEN_PORT) env.port = Number(e.TOTOKEN_PORT);
  if (e.TOTOKEN_UPSTREAM) env.upstream = e.TOTOKEN_UPSTREAM;
  if (e.TOTOKEN_REWRITER_MODEL) env.rewriterModel = e.TOTOKEN_REWRITER_MODEL;
  if (e.TOTOKEN_API_KEY) env.rewriterApiKey = e.TOTOKEN_API_KEY;
  if (e.TOTOKEN_TRANSLATE) env.translate = e.TOTOKEN_TRANSLATE !== '0';
  if (e.TOTOKEN_REWRITE_ENGLISH) env.rewriteEnglish = e.TOTOKEN_REWRITE_ENGLISH === '1';
  return env;
}

// A bad value in config.json must never take the proxy down: fall back to the default.
function sanitize(cfg) {
  const out = { ...cfg };
  if (!MODES.includes(out.mode)) out.mode = DEFAULTS.mode;
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) out.port = DEFAULTS.port;
  try {
    out.upstream = new URL(out.upstream).href.replace(/\/$/, '');
  } catch {
    out.upstream = DEFAULTS.upstream;
  }
  for (const k of ['minCharsForLLM', 'maxCharsForLLM', 'maxChars', 'timeoutMs', 'maxCacheEntries']) {
    if (!Number.isFinite(out[k]) || out[k] < 0) out[k] = DEFAULTS[k];
  }
  return out;
}

export function loadConfig(overrides = {}) {
  return sanitize({ ...DEFAULTS, ...readJson(configFile()), ...envConfig(), ...overrides });
}

export function saveConfig(patch) {
  ensureHome();
  const next = { ...readJson(configFile()), ...patch };
  for (const [k, v] of Object.entries(next)) if (v === undefined) delete next[k];
  fs.writeFileSync(configFile(), JSON.stringify(next, null, 2) + '\n');
  return next;
}

// Returns a getter that re-reads config.json when it changes on disk, so a mode
// switch applies to the running proxy without a restart.
export function liveConfig() {
  let stamp = -1;
  let cfg = null;
  return () => {
    let now = 0;
    try {
      now = fs.statSync(configFile()).mtimeMs;
    } catch {
      // no file: defaults
    }
    if (cfg === null || now !== stamp) {
      cfg = loadConfig();
      stamp = now;
    }
    return cfg;
  };
}
