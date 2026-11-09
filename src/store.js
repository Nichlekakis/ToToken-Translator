import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureHome, homeDir } from './config.js';

// Prompts may be sensitive: files that hold them are readable by the owner only.
const PRIVATE = { mode: 0o600 };
const MAX_STATS_BYTES = 4 * 1024 * 1024;

// Persistent original -> sent map. It makes rewrites repeatable across turns and
// restarts, so the conversation prefix stays byte-identical and prompt caching works.
export class RewriteCache {
  constructor({ file, maxEntries = 5000, persist = true } = {}) {
    this.file = file || path.join(homeDir(), 'cache.json');
    this.maxEntries = maxEntries;
    this.persist = persist;
    this.map = new Map();
    if (persist) {
      try {
        const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        for (const [k, v] of data) this.map.set(k, v);
      } catch {
        // empty cache
      }
    }
  }

  // The key depends only on the text: settings must not change how history is found.
  static key(text) {
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 32);
  }

  // A read refreshes the entry, so messages of a live conversation are evicted last.
  get(key) {
    const value = this.map.get(key);
    if (value !== undefined && this.map.size > this.maxEntries / 2) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key, value) {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) this.map.delete(this.map.keys().next().value);
    // Written before the request is forwarded: if the proxy dies right after, the
    // next one must still know what was sent (Windows gives no shutdown signal).
    this.flush();
  }

  flush() {
    if (!this.persist) return;
    try {
      ensureHome();
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...this.map]), PRIVATE);
      fs.renameSync(tmp, this.file);
    } catch {
      // the cache is best-effort; the in-memory copy still serves this run
    }
  }
}

export function statsFile() {
  return path.join(homeDir(), 'stats.jsonl');
}

export function recordStat(entry) {
  try {
    ensureHome();
    const file = statsFile();
    try {
      if (fs.statSync(file).size > MAX_STATS_BYTES) fs.renameSync(file, `${file}.old`);
    } catch {
      // no stats file yet
    }
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', PRIVATE);
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
