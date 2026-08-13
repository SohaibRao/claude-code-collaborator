import fs from 'node:fs';
import path from 'node:path';
import { teamDir, readJson } from './util.mjs';

export function status(root) {
  const team = teamDir(root);
  const count = (sub) => {
    try {
      return fs.readdirSync(path.join(team, sub)).filter((f) => f.endsWith('.md')).length;
    } catch {
      return 0;
    }
  };
  const settings = readJson(path.join(root, '.claude', 'settings.json'), {}) ?? {};
  const hookOk = (file) => JSON.stringify(settings.hooks || {}).includes(file);
  return {
    initialized: fs.existsSync(team),
    decisions: count('decisions'),
    knowledge: count('knowledge'),
    journal: count('journal'),
    hooks: {
      SessionStart: hookOk('session-start.mjs'),
      SessionEnd: hookOk('session-end.mjs'),
    },
  };
}
