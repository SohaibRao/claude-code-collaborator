#!/usr/bin/env node
// Claude Code Collaborator — distiller.
// Reads a session transcript, asks Claude (headless `claude -p`, using the developer's
// existing Claude Code auth) to extract durable team knowledge, and writes it into
// .claude/team/ where it is reviewed and committed like any other change.
//
// Usage:
//   node distill.mjs --transcript <path> [--cwd <dir>] [--session <id>] [--mock] [--dry-run]
//   node distill.mjs --reindex-only [--cwd <dir>]
//
// Vendored into .claude/team/hooks/ by `ccc init`. Zero dependencies.
import fs from 'node:fs';
import path from 'node:path';
import {
  findTeamDir,
  readJson,
  today,
  slugify,
  identity,
  parseTranscript,
  clip,
  callClaude,
  extractJsonObject,
  redactDeep,
} from './common.mjs';

// ---------- args ----------
const args = {};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    if (['mock', 'dry-run', 'reindex-only'].includes(key)) args[key] = true;
    else args[key] = argv[++i];
  }
}

const team = findTeamDir(args.cwd || process.cwd());
if (!team) {
  console.error('ccc: no .claude/team directory found — run `ccc init` first');
  process.exit(1);
}
const cfg = {
  model: 'haiku',
  maxTranscriptChars: 120000,
  distillTimeoutMs: 300000,
  redact: true,
  ...readJson(path.join(team, 'config.json'), {}),
};

// ---------- distillation prompt ----------
function buildPrompt(doc) {
  return `You are the memory distiller for a software team. Below is a transcript of one developer's Claude Code session on this project. Extract ONLY durable knowledge that would help a *different* developer's coding agent working on the same repository.

Return STRICT JSON (no markdown fences, no commentary) with this exact shape:
{
  "summary": "1-3 sentence digest of what this session worked on and accomplished",
  "decisions": [{ "title": "...", "what": "...", "why": "...", "rejected": "alternatives considered and why rejected, or empty string", "paths": ["optional/affected/paths"] }],
  "knowledge": [{ "title": "...", "body": "the gotcha/constraint/convention, stated as a fact with enough context to act on", "paths": ["optional/affected/paths"] }]
}

Rules:
- decisions = choices that constrain future work (architecture, libraries, formats, naming). knowledge = discovered constraints, gotchas, environment quirks, conventions.
- Include at most 5 of each. Return empty arrays if the session produced nothing durable (routine edits, Q&A, exploration).
- Never include secrets, tokens, or credentials.
- Do not restate what is obvious from reading the code itself; capture the *reasoning and constraints* that code cannot show.

TRANSCRIPT:
${doc}`;
}

function parseResult(raw) {
  const obj = extractJsonObject(raw);
  return {
    summary: typeof obj.summary === 'string' ? obj.summary : '',
    decisions: Array.isArray(obj.decisions) ? obj.decisions.filter((d) => d && d.title) : [],
    knowledge: Array.isArray(obj.knowledge) ? obj.knowledge.filter((k) => k && k.title) : [],
  };
}

// ---------- writing entries ----------
// Decisions are immutable records — never overwritten, suffixed if the slug collides.
function writeDecision(d, meta) {
  const dir = path.join(team, 'decisions');
  const slug = `${today()}-${slugify(d.title)}`;
  let file = path.join(dir, slug + '.md');
  let n = 2;
  while (fs.existsSync(file)) file = path.join(dir, `${slug}-${n++}.md`);
  const body = [
    '---',
    `title: ${d.title}`,
    `date: ${today()}`,
    `author: ${meta.author}`,
    `session: ${meta.session}`,
    'status: accepted',
    d.paths && d.paths.length ? `paths: ${JSON.stringify(d.paths)}` : null,
    '---',
    '',
    `**What:** ${d.what || d.title}`,
    '',
    `**Why:** ${d.why || '—'}`,
    '',
    d.rejected ? `**Rejected alternatives:** ${d.rejected}` : null,
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');
  fs.writeFileSync(file, body);
  return path.relative(team, file).replace(/\\/g, '/');
}

// Knowledge entries are living documents — the newest distillation for a slug wins.
function writeKnowledge(k, meta) {
  const dir = path.join(team, 'knowledge');
  const file = path.join(dir, slugify(k.title) + '.md');
  const body = [
    '---',
    `title: ${k.title}`,
    `date: ${today()}`,
    `author: ${meta.author}`,
    k.paths && k.paths.length ? `paths: ${JSON.stringify(k.paths)}` : null,
    '---',
    '',
    k.body || '',
    '',
  ]
    .filter((l) => l !== null)
    .join('\n');
  fs.writeFileSync(file, body);
  return path.relative(team, file).replace(/\\/g, '/');
}

// One journal file per author keeps concurrent teammates merge-conflict-free.
function appendJournal(summary, meta, written) {
  const file = path.join(team, 'journal', slugify(meta.author) + '.md');
  const lines = [`\n## ${today()} · session ${String(meta.session).slice(0, 8)}\n`, summary || '(no summary)', ''];
  if (written.length) lines.push(...written.map((w) => `- ${w}`), '');
  fs.appendFileSync(file, lines.join('\n'));
}

// ---------- index regeneration (deterministic, so merges stay clean) ----------
function parseFrontmatter(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  const meta = {};
  let body = raw;
  if (m) {
    body = m[2];
    for (const line of m[1].split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  const firstLine = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#')) || '';
  return { meta, firstLine };
}

function regenIndex() {
  const section = (dir, label) => {
    let files = [];
    try {
      files = fs.readdirSync(path.join(team, dir)).filter((f) => f.endsWith('.md')).sort();
    } catch {}
    if (!files.length) return `## ${label}\n\n_None recorded yet._\n`;
    const rows = files.map((f) => {
      const { meta, firstLine } = parseFrontmatter(path.join(team, dir, f));
      const title = meta.title || f.replace(/\.md$/, '');
      const extra = [meta.date, meta.author].filter(Boolean).join(', ');
      const pathsNote = meta.paths ? ` \`${meta.paths}\`` : '';
      return `- **${title}**${pathsNote} — ${firstLine}${extra ? ` _(${extra})_` : ''} → \`.claude/team/${dir}/${f}\``;
    });
    return `## ${label}\n\n${rows.join('\n')}\n`;
  };
  const out = [
    '# Team Memory Index',
    '',
    '<!-- Generated by Claude Code Collaborator (`ccc reindex`). Do not edit by hand. -->',
    '',
    section('decisions', 'Decisions'),
    section('knowledge', 'Knowledge'),
  ].join('\n');
  fs.writeFileSync(path.join(team, 'INDEX.md'), out);
}

// ---------- main ----------
if (args['reindex-only']) {
  regenIndex();
  console.log('ccc: INDEX.md regenerated');
  process.exit(0);
}

async function main() {
  if (!args.transcript) {
    console.error('ccc distill: --transcript <path> is required');
    process.exit(1);
  }
  const parsed = parseTranscript(args.transcript);
  const doc = clip(parsed.doc, cfg.maxTranscriptChars);
  if (!doc.trim()) {
    console.log('ccc: transcript has no conversational content — nothing to distill');
    return;
  }

  const meta = { author: identity(), session: args.session || 'manual' };

  let result;
  if (args.mock || process.env.CCC_MOCK_DISTILL) {
    result = {
      summary: 'Mock distillation for testing.',
      decisions: [{ title: 'Mock decision', what: 'Chose X over Y', why: 'testing', rejected: 'Y', paths: [] }],
      knowledge: [{ title: 'Mock knowledge', body: 'The build requires Node 18+.', paths: [] }],
    };
  } else {
    result = parseResult(await callClaude(buildPrompt(doc), cfg));
  }

  if (cfg.redact) result = redactDeep(result);

  if (args['dry-run']) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const written = [];
  for (const d of result.decisions) written.push(writeDecision(d, meta));
  for (const k of result.knowledge) written.push(writeKnowledge(k, meta));
  appendJournal(result.summary, meta, written);
  regenIndex();
  console.log(
    `ccc: distilled session ${meta.session} — ${result.decisions.length} decision(s), ${result.knowledge.length} knowledge entr(y/ies). Review with \`git diff .claude/team\` and commit.`,
  );
}

const lockFile = path.join(team, '.distill.lock');
fs.writeFileSync(lockFile, String(process.pid));
try {
  await main();
} catch (e) {
  console.error('ccc distill failed:', e.message);
  process.exitCode = 1;
} finally {
  try {
    fs.unlinkSync(lockFile);
  } catch {}
}
