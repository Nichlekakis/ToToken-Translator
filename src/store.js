import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureHome, homeDir } from './config.js';

// Persistent original -> compressed map. It keeps rewrites deterministic across
// turns, so the conversation prefix stays byte-identical and prompt caching works.
export class RewriteCache {
  constructor({ file, maxEntries = 5000, persist = true } = {}) {
    this.file = file || path.join(homeDir(), 'cache.json');
    this.maxEntries = maxEntries;
    this.persist = persist;
    this.map = new Map();
    this.timer = null;
    if (persist) {
      try {
        const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        for (const [k, v] of data) this.map.set(k, v);
      } catch {
        // empty cache
      }
    }
  }

  static key(text, salt = '') {
    return crypto.createHash('sha256').update(salt).update('\0').update(text).digest('hex').slice(0, 32);
  }

  get(key) {
    return this.map.get(key);
  }

  set(key, value) {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value);
    this.scheduleSave();
  }

  scheduleSave() {
    if (!this.persist || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 500);
    this.timer.unref?.();
  }

  flush() {
    if (!this.persist) return;
    ensureHome();
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify([...this.map]));
    fs.renameSync(tmp, this.file);
  }
}

export function statsFile() {
  return path.join(homeDir(), 'stats.jsonl');
}

export function recordStat(entry) {
  try {
    ensureHome();
    fs.appendFileSync(statsFile(), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch {
    // stats are best-effort
  }
}

export function readStats() {
  let lines = [];
  try {
    lines = fs.readFileSync(statsFile(), 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
  return lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
}
