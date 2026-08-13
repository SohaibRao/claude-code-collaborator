#!/usr/bin/env node
// Claude Code Collaborator — session handoff (Phase 3).
// Packages an in-flight session (state summary, next steps, todo list, working
// diff, transcript tail) into a portable bundle a teammate resumes with full
// context — across desks, timezones, or shifts.
//
// Usage (normally via `ccc handoff` / `ccc resume` / `ccc inbox`):
//   node handoff.mjs create [--cwd <dir>] [--transcript <path>] [--title "..."] [--session <id>] [--mock] [--no-upload]
//   node handoff.mjs stage <id> [--cwd <dir>] [--print]
//   node handoff.mjs list [--cwd <dir>]
//
// Bundles travel two ways: committed in .claude/team/handoffs/ (git-native, zero
// infra) and/or uploaded to the sync server when presence is configured.
// Vendored into .claude/team/hooks/ by `ccc init`. Zero dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  findTeamDir,
  readJson,
  identity,
  findLatestTranscript,
  parseTranscript,
  clip,
  callClaude,
  extractJsonObject,
  redactDeep,
} from './common.mjs';
import { presenceConfig, repoName, postHandoff, getHandoff, listHandoffs, formatAge } from './presence.mjs';

const MAX_DIFF_CHARS = 60000;
const MAX_EXCERPT_CHARS = 4000;

// ---------- args ----------
const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : '';
const positional = argv[1] && !argv[1].startsWith('--') ? argv[1] : '';
const args = {};
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  const key = argv[i].slice(2);
  if (['mock', 'no-upload', 'print'].includes(key)) args[key] = true;
  else args[key] = argv[++i];
}

const team = findTeamDir(args.cwd || process.cwd());
if (!team) {
  console.error('ccc: no .claude/team directory found — run `ccc init` first');
  process.exit(1);
}
const root = path.resolve(team, '..', '..');
const cfg = { model: 'haiku', maxTranscriptChars: 120000, distillTimeoutMs: 300000, redact: true, ...readJson(path.join(team, 'config.json'), {}) };
const presence = presenceConfig(team);
const handoffDir = path.join(team, 'handoffs');

function captureDiff() {
  try {
    const status = spawnSync('git', ['-C', root, 'status', '--short'], { encoding: 'utf8' });
    if (status.error || status.status !== 0) return '(git unavailable — working diff not captured)';
    if (!(status.stdout || '').trim()) return '(working tree clean)';
    const diff = spawnSync('git', ['-C', root, 'diff', 'HEAD'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    let out = `# git status --short\n${status.stdout}\n# git diff HEAD\n${diff.stdout || ''}`;
    if (out.length > MAX_DIFF_CHARS) out = out.slice(0, MAX_DIFF_CHARS) + '\n…(diff truncated)';
    return out;
  } catch {
    return '(git unavailable — working diff not captured)';
  }
}

function buildPrompt(doc) {
  return `You are preparing a work handoff between two developers' coding agents. Below is the transcript of the departing developer's Claude Code session. Summarize the state of the work so the successor can continue WITHOUT redoing or re-deriving anything.

Return STRICT JSON (no markdown fences, no commentary):
{
  "title": "5-10 word name for the work being handed off",
  "summary": "what was being worked on, why, current state: what is DONE and verified, what is IN PROGRESS, what is NOT started",
  "nextSteps": ["ordered, concrete next actions the successor should take"],
  "warnings": ["in-flight gotchas: half-applied changes, failing tests, decisions mid-flight, things that look done but aren't"]
}

Rules: be specific (file paths, function names, commands). Never include secrets, tokens, or credentials.

TRANSCRIPT:
${doc}`;
}

function renderContext(bundle) {
  const age = formatAge(Math.round((Date.now() - bundle.createdAt) / 1000));
  const todoLines = (bundle.todos || []).map((t) => `- [${t.status === 'completed' ? 'x' : ' '}] ${t.content}${t.status === 'in_progress' ? ' ← was in progress' : ''}`);
  const steps = (bundle.nextSteps || []).map((s, i) => `${i + 1}. ${s}`);
  const warns = (bundle.warnings || []).map((w) => `- ${w}`);
  return [
    '<handoff>',
    `Incoming work handoff from ${bundle.from} (created ${age}, id ${bundle.id}).`,
    '',
    `# ${bundle.title}`,
    '',
    '## State summary',
    bundle.summary || '(none)',
    ...(steps.length ? ['', '## Next steps', ...steps] : []),
    ...(warns.length ? ['', '## Warnings — read before touching anything', ...warns] : []),
    ...(todoLines.length ? ['', '## Todo list at handoff', ...todoLines] : []),
    ...(bundle.diff && !bundle.diff.startsWith('(')
      ? ['', '## Working diff at handoff (may since have been committed or reverted — verify)', '```diff', bundle.diff, '```']
      : bundle.diff
        ? ['', `## Working diff at handoff: ${bundle.diff}`]
        : []),
    ...(bundle.excerpts ? ['', '## Final transcript excerpt from the departing session', bundle.excerpts] : []),
    '',
    "Continue this work: first verify the repo's current state against the summary (files may have moved on), adopt the todo list via TodoWrite adjusting for anything already done, then proceed with the next steps. Flag to the user anything that contradicts the summary.",
    '</handoff>',
  ].join('\n');
}

async function create() {
  const transcript = args.transcript || findLatestTranscript(root);
  if (!transcript || !fs.existsSync(transcript)) {
    console.error('ccc handoff: no transcript found for this project — pass --transcript <path>');
    process.exit(1);
  }
  const parsed = parseTranscript(transcript);
  const doc = clip(parsed.doc, cfg.maxTranscriptChars);
  if (!doc.trim()) {
    console.error('ccc handoff: transcript has no conversational content');
    process.exit(1);
  }

  let summary;
  if (args.mock || process.env.CCC_MOCK_DISTILL) {
    summary = {
      title: 'Mock handoff',
      summary: 'Mock handoff summary: storage interface wired, spawn fix pending.',
      nextSteps: ['Finish the spawn shell fix', 'Run the test suite'],
      warnings: ['The storage migration is half-applied'],
    };
  } else {
    const obj = extractJsonObject(await callClaude(buildPrompt(doc), cfg));
    summary = {
      title: String(obj.title || 'Untitled handoff'),
      summary: String(obj.summary || ''),
      nextSteps: Array.isArray(obj.nextSteps) ? obj.nextSteps.map(String) : [],
      warnings: Array.isArray(obj.warnings) ? obj.warnings.map(String) : [],
    };
  }

  let bundle = {
    id: `hf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    repo: repoName(team),
    from: identity(presence.user),
    createdAt: Date.now(),
    sessionId: args.session || '',
    title: args.title || summary.title,
    summary: summary.summary,
    nextSteps: summary.nextSteps,
    warnings: summary.warnings,
    todos: parsed.todos,
    diff: captureDiff(),
    excerpts: parsed.doc.slice(-MAX_EXCERPT_CHARS),
  };
  if (cfg.redact) bundle = redactDeep(bundle);

  fs.mkdirSync(handoffDir, { recursive: true });
  const localFile = path.join(handoffDir, `${bundle.id}.json`);
  fs.writeFileSync(localFile, JSON.stringify(bundle, null, 2));

  let uploaded = false;
  if (presence.enabled && !args['no-upload']) {
    uploaded = Boolean(await postHandoff(presence, team, bundle));
  }

  console.log(`ccc: handoff ${bundle.id} created — "${bundle.title}"`);
  console.log(`  local:  .claude/team/handoffs/${bundle.id}.json (commit it to share via git)`);
  console.log(`  server: ${uploaded ? 'uploaded to sync server' : presence.enabled ? 'upload FAILED — share via git instead' : 'presence not configured — share via git'}`);
  console.log(`\nTeammate picks it up with:  ccc resume ${bundle.id}`);
}

async function stage() {
  const id = positional;
  if (!id) {
    console.error('ccc resume: handoff id required (see `ccc inbox`)');
    process.exit(1);
  }
  let bundle = readJson(path.join(handoffDir, `${id}.json`));
  if (!bundle && presence.enabled) bundle = await getHandoff(presence, team, id);
  if (!bundle || !bundle.id) {
    console.error(`ccc resume: handoff ${id} not found locally or on the sync server`);
    process.exit(1);
  }
  const context = renderContext(bundle);
  if (args.print) {
    console.log(context);
    return;
  }
  fs.writeFileSync(path.join(team, '.handoff-pending.json'), JSON.stringify({ id: bundle.id, stagedAt: Date.now(), context }));
  console.log(`ccc: handoff ${bundle.id} staged — "${bundle.title}" from ${bundle.from}`);
  console.log('Start a Claude Code session in this project to pick it up (injected once, then consumed).');
}

async function list() {
  const rows = new Map();
  try {
    for (const f of fs.readdirSync(handoffDir).filter((f) => f.endsWith('.json'))) {
      const b = readJson(path.join(handoffDir, f));
      if (b && b.id) rows.set(b.id, { ...b, where: 'git' });
    }
  } catch {}
  if (presence.enabled) {
    const res = await listHandoffs(presence, team);
    for (const b of (res && res.handoffs) || []) {
      rows.set(b.id, { ...b, where: rows.has(b.id) ? 'git+server' : 'server' });
    }
  }
  if (!rows.size) {
    console.log('No handoffs for this project.');
    return;
  }
  const sorted = [...rows.values()].sort((a, b) => b.createdAt - a.createdAt);
  for (const b of sorted) {
    console.log(`${b.id}  ${formatAge(Math.round((Date.now() - b.createdAt) / 1000)).padEnd(8)}  ${String(b.from).padEnd(15)}  ${b.title}  [${b.where}]`);
  }
  console.log(`\nResume one with:  ccc resume <id>`);
}

try {
  if (cmd === 'create') await create();
  else if (cmd === 'stage') await stage();
  else if (cmd === 'list') await list();
  else {
    console.error('usage: handoff.mjs create|stage <id>|list [options]');
    process.exit(1);
  }
} catch (e) {
  console.error('ccc handoff failed:', e.message);
  process.exit(1);
}
