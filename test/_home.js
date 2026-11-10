// Imported first by every test file: keeps stats, cache and config out of the real home.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'totoken-test-'));
process.env.TOTOKEN_HOME = path.join(dir, 'home');
process.env.CLAUDE_CONFIG_DIR = path.join(dir, 'claude');
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
