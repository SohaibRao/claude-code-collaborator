import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Walk up from startDir to the nearest directory containing .git or .claude.
 * The walk stops at the home directory: ~/.claude is Claude's global config,
 * not a project marker, and treating it as one would write into user-level state.
 */
export function findProjectRoot(startDir) {
  const home = path.resolve(os.homedir());
  let dir = path.resolve(startDir);
  while (true) {
    if (dir === home) return path.resolve(startDir);
    if (fs.existsSync(path.join(dir, '.git')) || fs.existsSync(path.join(dir, '.claude'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir);
    dir = parent;
  }
}

export function teamDir(root) {
  return path.join(root, '.claude', 'team');
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}
