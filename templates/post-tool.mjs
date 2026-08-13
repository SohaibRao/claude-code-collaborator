#!/usr/bin/env node
// Claude Code Collaborator — PostToolUse hook (matcher: Write|Edit|NotebookEdit).
// Publishes "this session touched this file" to the sync server and, when the
// server reports another developer in the same file recently, hands the agent
// an advisory warning as additional context. Warn, don't block.
// Must never break a session: every failure path exits 0. No-op when presence
// is not configured.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { presenceConfig, identity, repoName, postEvent, formatAge } from './presence.mjs';

// Walk stops at the home directory: ~/.claude is global config, never a project.
function findTeamDir(startDir) {
  const home = path.resolve(os.homedir());
  let dir = path.resolve(startDir);
  while (true) {
    if (dir === home) return null;
    const candidate = path.join(dir, '.claude', 'team');
    if (fs.existsSync(path.join(candidate, 'INDEX.md'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function readStdin() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

try {
  const input = JSON.parse((await readStdin()) || '{}');
  const team = findTeamDir(input.cwd || process.cwd());
  if (!team) process.exit(0);
  const cfg = presenceConfig(team);
  if (!cfg.enabled) process.exit(0);

  const toolInput = input.tool_input || {};
  const file = toolInput.file_path || toolInput.notebook_path;
  if (!file) process.exit(0);

  const root = path.resolve(team, '..', '..');
  let rel = path.relative(root, path.resolve(input.cwd || root, file));
  if (rel.startsWith('..')) process.exit(0); // outside the project — not team-relevant
  rel = rel.replace(/\\/g, '/');

  const reply = await postEvent(cfg, team, {
    type: 'file_touch',
    sessionId: input.session_id || 'unknown',
    user: identity(cfg),
    repo: repoName(team),
    path: rel,
  });

  const conflicts = (reply && reply.conflicts) || [];
  const live = conflicts.filter((c) => !c.sessionEnded);
  const recent = conflicts.filter((c) => c.sessionEnded);
  if (conflicts.length) {
    const who = (list) => [...new Set(list.map((c) => `${c.user} (${formatAge(c.ageSeconds)})`))].join(', ');
    const parts = [];
    if (live.length) parts.push(`another ACTIVE session is editing it right now: ${who(live)}`);
    if (recent.length) parts.push(`recently edited by: ${who(recent)}`);
    const context = `[team-presence] Heads-up on ${rel} — ${parts.join('; ')}. This is advisory: continue if the work is coordinated, but consider flagging the overlap to the user to avoid conflicting changes.`;
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: context } }),
    );
  }
} catch {}
process.exit(0);
