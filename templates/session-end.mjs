#!/usr/bin/env node
// Claude Code Collaborator — SessionEnd hook.
// Launches the distiller as a detached process so session shutdown is never blocked.
// Vendored into .claude/team/hooks/ by `ccc init`. Zero dependencies.
// Must never break a session: every failure path exits 0.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { presenceConfig, identity, repoName, postEvent } from './presence.mjs';

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

  // Presence goodbye fires regardless of whether the session is worth distilling.
  const presence = presenceConfig(team);
  if (presence.enabled) {
    await postEvent(presence, team, {
      type: 'session_end',
      sessionId: input.session_id || 'unknown',
      user: identity(presence),
      repo: repoName(team),
    });
  }

  const transcript = input.transcript_path;
  if (!transcript || !fs.existsSync(transcript)) process.exit(0);

  // Short sessions (a quick question, an aborted start) have nothing durable to distill.
  const minBytes = cfg.minTranscriptBytes ?? 2000;
  if (fs.statSync(transcript).size < minBytes) process.exit(0);

  // One distill at a time; a stale lock (>10 min) is treated as dead.
  const lock = path.join(team, '.distill.lock');
  try {
    const age = Date.now() - fs.statSync(lock).mtimeMs;
    if (age < 10 * 60 * 1000) process.exit(0);
  } catch {}

  const log = fs.openSync(path.join(team, '.distill.log'), 'a');
  const child = spawn(
    process.execPath,
    [
      path.join(team, 'hooks', 'distill.mjs'),
      '--transcript', transcript,
      '--cwd', input.cwd || process.cwd(),
      '--session', input.session_id || 'unknown',
    ],
    { detached: true, stdio: ['ignore', log, log] },
  );
  child.unref();
} catch {}
process.exit(0);
