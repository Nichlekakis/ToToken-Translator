import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_UPSTREAM, saveConfig } from '../config.js';
import { baseUrl } from './daemon.js';

export function settingsPath() {
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');
}

// Returns {} only when the file does not exist. A file that exists but cannot be
// parsed is never overwritten: that would erase the user's settings.
export function readSettings(file = settingsPath()) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`não consegui ler ${file}: ${err.message}`);
  }
  if (!raw.trim()) return {};
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(`${file} não é um JSON válido. Corrija o arquivo e rode de novo; não alterei nada.`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${file} tem um formato inesperado; não alterei nada.`);
  return data;
}

function writeSettings(settings, file = settingsPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.totoken-backup`);
  const tmp = `${file}.totoken-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

const isOurs = (url) => /^https?:\/\/(127\.0\.0\.1|localhost):\d+\/?$/.test(String(url || ''));

export function pointedAtProxy(cfg) {
  try {
    return readSettings().env?.ANTHROPIC_BASE_URL === baseUrl(cfg);
  } catch {
    return false;
  }
}

// Points Claude Code at the proxy, remembering any base URL that was there before.
export function install(cfg) {
  const settings = readSettings();
  const current = settings.env?.ANTHROPIC_BASE_URL;
  if (current === baseUrl(cfg)) {
    console.log(`O Claude Code já usa ${baseUrl(cfg)}.`);
    return;
  }
  if (current && !isOurs(current)) {
    saveConfig({ upstream: current });
    console.log(`Endereço anterior preservado como destino do proxy: ${current}`);
  }
  settings.env = { ...settings.env, ANTHROPIC_BASE_URL: baseUrl(cfg) };
  writeSettings(settings);
  console.log(`Claude Code agora usa ${baseUrl(cfg)}. O hook do plugin mantém o proxy ligado.`);
}

// Undoes install(): restores the previous base URL, or removes ours.
export function uninstall(cfg) {
  const settings = readSettings();
  const current = settings.env?.ANTHROPIC_BASE_URL;
  if (!isOurs(current)) {
    console.log('O Claude Code não estava apontado para o ToToken.');
    return;
  }
  if (cfg.upstream && cfg.upstream !== DEFAULT_UPSTREAM) {
    settings.env.ANTHROPIC_BASE_URL = cfg.upstream;
    saveConfig({ upstream: undefined });
    console.log(`ANTHROPIC_BASE_URL voltou para ${cfg.upstream}.`);
  } else {
    delete settings.env.ANTHROPIC_BASE_URL;
    if (!Object.keys(settings.env).length) delete settings.env;
    console.log('ANTHROPIC_BASE_URL removido.');
  }
  writeSettings(settings);
}
