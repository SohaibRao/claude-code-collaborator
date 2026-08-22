#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findProjectRoot, teamDir } from '../lib/util.mjs';
import { init } from '../lib/init.mjs';
import { status } from '../lib/status.mjs';

const VERSION = '0.5.0';
const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const HELP = `ccc — Claude Code Collaborator v${VERSION}
Git-native shared team memory + live presence + session handoff for Claude Code.

Usage:
  ccc init                 Set up .claude/team/, hooks, and MCP server (idempotent)
  ccc status               Show team memory contents and hook registration
  ccc distill [options]    Distill a session transcript into team memory
      --transcript <path>    transcript to distill (default: latest for this project)
      --dry-run              print extracted entries without writing files
      --mock                 use canned output instead of calling Claude (testing)
  ccc reindex              Regenerate .claude/team/INDEX.md from entry files
  ccc handoff [options]    Package the latest session into a handoff bundle
      --title "..."          override the generated title
      --transcript <path>    transcript to package (default: latest for this project)
      --no-upload            keep the bundle git-only (skip sync server upload)
  ccc resume <id>          Stage a handoff — the next session here picks it up
      --print                print the handoff context instead of staging it
  ccc inbox                List handoffs available for this project
  ccc serve [options]      Run the team sync server (presence & handoff storage)
      --port <n>             port to listen on (default 7377)
      --token <secret>       require Bearer token auth (recommended)
      --state <file>         JSON snapshot file so restarts keep state
  ccc live [options]       Run the shared live-session server (ccc-live companion)
      --port <n>             port to listen on (default 7378)
      --token <secret>       require Bearer token auth (recommended)
      --model <m>            model for room agents
      --mock                 mock agent — no SDK or API calls (demos/tests)
  ccc version              Print version

After init, commit .claude/ and .mcp.json so your team gets everything on git pull.
To enable live presence, run \`ccc serve\` somewhere the team can reach and put its
URL in .claude/team/config.json under presence.url.`;

const [cmd, ...rest] = process.argv.slice(2);
const root = findProjectRoot(process.cwd());

// Claude Code stores transcripts under ~/.claude/projects/<munged-project-path>/.
function findLatestTranscript(projectRoot) {
  const munged = path.resolve(projectRoot).replace(/[^a-zA-Z0-9-]/g, '-');
  const dir = path.join(os.homedir(), '.claude', 'projects', munged);
  let best = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(dir, f);
      const mtime = fs.statSync(full).mtimeMs;
      if (!best || mtime > best.mtime) best = { full, mtime };
    }
  } catch {}
  return best ? best.full : null;
}

function requireVendored(file) {
  const script = path.join(teamDir(root), 'hooks', file);
  if (!fs.existsSync(script)) {
    console.error('Not initialized — run `ccc init` first.');
    process.exit(1);
  }
  return script;
}

switch (cmd) {
  case 'init': {
    const { added } = init(root);
    console.log(`Initialized Claude Code Collaborator in ${teamDir(root)}`);
    console.log(added.length ? `Registered hooks: ${added.join(', ')}` : 'Hooks already registered — nothing to change.');
    if (!fs.existsSync(path.join(root, '.git'))) {
      console.log('\nnote: this directory is not a git repository — team memory only reaches teammates once it is committed and pushed.');
    }
    console.log(`\nNext steps:
  1. Commit .claude/ and .gitignore so your team gets the hooks on git pull.
  2. Work normally — when a session ends, durable knowledge is distilled into .claude/team/.
  3. Review with \`git diff .claude/team\` and commit it with your code.`);
    break;
  }

  case 'status': {
    const s = status(root);
    if (!s.initialized) {
      console.log('Not initialized — run `ccc init`.');
      break;
    }
    console.log(`Team memory at ${teamDir(root)}
  decisions: ${s.decisions}   knowledge: ${s.knowledge}   journal files: ${s.journal}
  hooks: SessionStart ${s.hooks.SessionStart ? 'ok' : 'MISSING'} · SessionEnd ${s.hooks.SessionEnd ? 'ok' : 'MISSING'}`);
    break;
  }

  case 'distill': {
    const script = requireVendored('distill.mjs');
    const argv = [...rest];
    if (!argv.includes('--transcript')) {
      const t = findLatestTranscript(root);
      if (!t) {
        console.error('No transcript found for this project under ~/.claude/projects — pass --transcript <path>.');
        process.exit(1);
      }
      console.log(`Using latest transcript: ${t}`);
      argv.push('--transcript', t);
    }
    const r = spawnSync(process.execPath, [script, ...argv, '--cwd', root], { stdio: 'inherit' });
    process.exit(r.status ?? 0);
    break;
  }

  case 'reindex': {
    const script = requireVendored('distill.mjs');
    const r = spawnSync(process.execPath, [script, '--reindex-only', '--cwd', root], { stdio: 'inherit' });
    process.exit(r.status ?? 0);
    break;
  }

  case 'handoff': {
    const script = requireVendored('handoff.mjs');
    const r = spawnSync(process.execPath, [script, 'create', ...rest, '--cwd', root], { stdio: 'inherit' });
    process.exit(r.status ?? 0);
    break;
  }

  case 'resume': {
    const script = requireVendored('handoff.mjs');
    if (!rest[0] || rest[0].startsWith('--')) {
      console.error('usage: ccc resume <handoff-id> [--print]   (see `ccc inbox`)');
      process.exit(1);
    }
    const r = spawnSync(process.execPath, [script, 'stage', ...rest, '--cwd', root], { stdio: 'inherit' });
    process.exit(r.status ?? 0);
    break;
  }

  case 'inbox': {
    const script = requireVendored('handoff.mjs');
    const r = spawnSync(process.execPath, [script, 'list', '--cwd', root], { stdio: 'inherit' });
    process.exit(r.status ?? 0);
    break;
  }

  case 'serve': {
    const r = spawnSync(process.execPath, [path.join(PKG_ROOT, 'server', 'sync-server.mjs'), ...rest], {
      stdio: 'inherit',
    });
    process.exit(r.status ?? 0);
    break;
  }

  case 'live': {
    const script = path.join(PKG_ROOT, 'live', 'live-server.mjs');
    if (!fs.existsSync(script)) {
      console.error(
        'ccc live: the ccc-live companion package is not present alongside this install.\n' +
          'Clone the ccc repository (live/ ships there) or install ccc-live and run `ccc-live` directly.',
      );
      process.exit(1);
    }
    const argv = [...rest];
    if (!argv.includes('--cwd')) argv.push('--cwd', root);
    const r = spawnSync(process.execPath, [script, ...argv], { stdio: 'inherit' });
    process.exit(r.status ?? 0);
    break;
  }

  case 'version':
  case '--version':
  case '-v':
    console.log(VERSION);
    break;

  default:
    console.log(HELP);
}
