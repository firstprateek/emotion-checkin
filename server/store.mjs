// JSON file persistence. Each file is read once into memory and written atomically
// (write a temp file in the same folder, then rename over the original).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const FILES = {
  vapid: 'vapid.json',
  settings: 'settings.json',
  subscriptions: 'subscriptions.json',
  records: 'records.json',
  state: 'state.json',
};

export function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(value, null, 2) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

export function readJson(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    // Keep the unreadable file for inspection instead of silently overwriting it later.
    const aside = `${file}.corrupt-${Date.now()}`;
    fs.renameSync(file, aside);
    console.error(`[store] ${path.basename(file)} was not valid JSON; moved it to ${path.basename(aside)}.`);
    return fallback;
  }
}

/**
 * createStore(dataDir) -> { dir, get(name), set(name, value) }
 * `get` returns the cached value (callers must treat it as read-only or call `set` after changing it).
 */
export function createStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const cache = new Map();
  const fileFor = (name) => {
    if (!FILES[name]) throw new Error(`Unknown store file: ${name}`);
    return path.join(dataDir, FILES[name]);
  };
  return {
    dir: dataDir,
    get(name, fallback = null) {
      if (!cache.has(name)) cache.set(name, readJson(fileFor(name), fallback));
      return cache.get(name);
    },
    set(name, value) {
      writeJsonAtomic(fileFor(name), value);
      cache.set(name, value);
      return value;
    },
  };
}
