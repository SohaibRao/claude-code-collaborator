import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { teamDir, readJson, writeJson } from './util.mjs';

const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates');

// Hook scripts are vendored into the repo so teammates need nothing but Node —
// no npm install, no global package. `ccc init` re-copies them on upgrade.
const HOOK_DEFS = {
  SessionStart: { file: 'session-start.mjs', timeout: 20 },
  SessionEnd: { file: 'session-end.mjs', timeout: 30 },
  PostToolUse: { file: 'post-tool.mjs', timeout: 10, matcher: 'Write|Edit|NotebookEdit' },
};

const VENDORED = [
  'common.mjs',
  'session-start.mjs',
  'session-end.mjs',
  'distill.mjs',
  'presence.mjs',
  'post-tool.mjs',
  'mcp-server.mjs',
  'handoff.mjs',
];

export function init(root) {
  const team = teamDir(root);
  for (const sub of ['decisions', 'knowledge', 'journal', 'handoffs', 'hooks']) {
    fs.mkdirSync(path.join(team, sub), { recursive: true });
  }
  for (const sub of ['decisions', 'knowledge', 'journal', 'handoffs']) {
    const keep = path.join(team, sub, '.gitkeep');
    if (!fs.existsSync(keep)) fs.writeFileSync(keep, '');
  }

  const cfgPath = path.join(team, 'config.json');
  if (!fs.existsSync(cfgPath)) fs.copyFileSync(path.join(TEMPLATES, 'config.json'), cfgPath);

  const idxPath = path.join(team, 'INDEX.md');
  if (!fs.existsSync(idxPath)) {
    fs.writeFileSync(idxPath, '# Team Memory Index\n\n_No entries yet. Entries appear here after the first distilled session._\n');
  }

  for (const f of VENDORED) {
    fs.copyFileSync(path.join(TEMPLATES, f), path.join(team, 'hooks', f));
  }

  // Merge our hooks into project settings without disturbing anything else there.
  const settingsPath = path.join(root, '.claude', 'settings.json');
  const settings = readJson(settingsPath, {}) ?? {};
  settings.hooks = settings.hooks || {};
  const added = [];
  for (const [event, def] of Object.entries(HOOK_DEFS)) {
    const entries = (settings.hooks[event] = settings.hooks[event] || []);
    const exists = entries.some((e) => (e.hooks || []).some((h) => (h.command || '').includes(def.file)));
    if (!exists) {
      entries.push({
        ...(def.matcher ? { matcher: def.matcher } : {}),
        hooks: [{ type: 'command', command: `node .claude/team/hooks/${def.file}`, timeout: def.timeout }],
      });
      added.push(event);
    }
  }
  writeJson(settingsPath, settings);

  // Register the team-context MCP server (project-scoped, shared via git).
  const mcpPath = path.join(root, '.mcp.json');
  const mcp = readJson(mcpPath, {}) ?? {};
  mcp.mcpServers = mcp.mcpServers || {};
  if (!mcp.mcpServers['team-context']) {
    mcp.mcpServers['team-context'] = { command: 'node', args: ['.claude/team/hooks/mcp-server.mjs'] };
    writeJson(mcpPath, mcp);
    added.push('mcp:team-context');
  }

  // Runtime scratch files must never be committed.
  const giPath = path.join(root, '.gitignore');
  const giLines = [
    '.claude/team/.distill.log',
    '.claude/team/.distill.lock',
    '.claude/team/.presence-down',
    '.claude/team/.handoff-pending.json',
  ];
  const gi = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : '';
  const present = new Set(gi.split(/\r?\n/));
  const missing = giLines.filter((l) => !present.has(l));
  if (missing.length) {
    fs.writeFileSync(giPath, (gi ? gi.replace(/\n*$/, '\n') : '') + missing.join('\n') + '\n');
  }

  return { team, added };
}
