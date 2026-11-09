import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import './_home.js';

// config and settings read their paths lazily, after _home.js set them
const { loadConfig, liveConfig, saveConfig, DEFAULTS } = await import('../src/config.js');
const { install, uninstall, readSettings, settingsPath } = await import('../src/cli/settings.js');

const quiet = (fn) => {
  const log = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = log;
  }
};
const write = (text) => {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), text);
};

test('install keeps the other settings and uninstall puts everything back', () => {
  write(JSON.stringify({ model: 'opus', env: { FOO: '1' } }));
  quiet(() => install(loadConfig()));
  assert.deepEqual(readSettings(), { model: 'opus', env: { FOO: '1', ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' } });
  quiet(() => uninstall(loadConfig()));
  assert.deepEqual(readSettings(), { model: 'opus', env: { FOO: '1' } });
});

test('a previous base URL becomes the upstream and is restored on uninstall', () => {
  write(JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gateway.example.com' } }));
  quiet(() => install(loadConfig()));
  assert.equal(loadConfig().upstream, 'https://gateway.example.com');
  quiet(() => uninstall(loadConfig()));
  assert.equal(readSettings().env.ANTHROPIC_BASE_URL, 'https://gateway.example.com');
  assert.equal(loadConfig().upstream, DEFAULTS.upstream);
});

test('a settings file that is not valid JSON is never overwritten', () => {
  const broken = '{ "model": "opus", // comentário\n}';
  write(broken);
  assert.throws(() => install(loadConfig()), /JSON válido/);
  assert.throws(() => uninstall(loadConfig()), /JSON válido/);
  assert.equal(fs.readFileSync(settingsPath(), 'utf8'), broken);
});

test('bad config values fall back to defaults and mode changes apply live', () => {
  saveConfig({ mode: 'turbo', port: 'abc', upstream: 'not a url' });
  const c = loadConfig();
  assert.equal(c.mode, DEFAULTS.mode);
  assert.equal(c.port, DEFAULTS.port);
  assert.equal(c.upstream, DEFAULTS.upstream);
  const live = liveConfig();
  saveConfig({ mode: 'local', port: undefined, upstream: undefined });
  fs.utimesSync(path.join(process.env.TOTOKEN_HOME, 'config.json'), new Date(), new Date(Date.now() + 5000));
  assert.equal(live().mode, 'local');
});
