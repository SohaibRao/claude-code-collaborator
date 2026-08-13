#!/usr/bin/env node
// Claude Code Collaborator — SessionStart hook.
// Injects the distilled team memory index into the session as additional context.
// Vendored into .claude/team/hooks/ by `ccc init`. Zero dependencies.
// Must never break a session: every failure path exits 0 with no output.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { presenceConfig, identity, repoName, postEvent, getActivity, formatAge } from './presence.mjs';

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

  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(path.join(team, 'config.json'), 'utf8'));
  } catch {}
  const max = cfg.maxIndexChars || 8000;

  const blocks = [];

  // Block 1 — distilled team memory (Phase 1).
  let index = fs.readFileSync(path.join(team, 'INDEX.md'), 'utf8').trim();
  if (index && !index.includes('_No entries yet')) {
    if (index.length > max) {
      index = index.slice(0, max) + '\n…(index truncated — read .claude/team/INDEX.md for the rest)';
    }
    blocks.push(
      [
        '<team-memory>',
        "Shared team memory for this project (Claude Code Collaborator, stored in .claude/team/). Every developer's Claude sessions contribute to it and read from it.",
        'Respect the recorded decisions below — if a task would contradict one, flag the conflict to the user instead of silently overriding it. For full detail, read the linked files under .claude/team/.',
        '',
        index,
        '</team-memory>',
      ].join('\n'),
    );
  }

  // Block 2 — live team presence (Phase 2), only when a sync server is configured.
  const presence = presenceConfig(team);
  if (presence.enabled) {
    const sessionId = input.session_id || 'unknown';
    await postEvent(presence, team, {
      type: 'session_start',
      sessionId,
      user: identity(presence),
      repo: repoName(team),
    });
    const act = await getActivity(presence, team);
    const others = ((act && act.sessions) || []).filter((s) => s.sessionId !== String(sessionId).slice(0, 8));
    if (others.length) {
      const lines = others.map((s) => {
        const files = (s.recentFiles || []).map((f) => f.path).slice(0, 3).join(', ');
        return `- ${s.user}${s.task ? ` — working on: ${s.task}` : ''}${files ? ` — recent files: ${files}` : ''} (last active ${formatAge(s.idleSeconds)})`;
      });
      blocks.push(
        [
          '<team-presence>',
          'Teammates with active Claude Code sessions on this project right now:',
          ...lines,
          'Coordinate before sweeping changes to files or areas they are working in; the check_file_activity MCP tool can verify overlap on demand.',
          '</team-presence>',
        ].join('\n'),
      );
    }
  }

  // Block 3 — a staged handoff (Phase 3), consumed exactly once.
  const pendingPath = path.join(team, '.handoff-pending.json');
  if (fs.existsSync(pendingPath)) {
    try {
      const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
      if (pending && pending.context) blocks.push(pending.context);
    } catch {}
    try {
      fs.unlinkSync(pendingPath);
    } catch {}
  }

  if (!blocks.length) process.exit(0);
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: blocks.join('\n\n') },
    }),
  );
} catch {}
process.exit(0);
