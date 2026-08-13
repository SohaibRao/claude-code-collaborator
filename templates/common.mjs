// Claude Code Collaborator — shared helpers for the vendored scripts.
// Zero dependencies. Imported relatively by distill.mjs, handoff.mjs, and friends.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

// Walk stops at the home directory: ~/.claude is global config, never a project.
export function findTeamDir(startDir) {
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

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

export function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'entry'
  );
}

export function identity(preferred = '') {
  if (preferred) return preferred;
  try {
    const r = spawnSync('git', ['config', 'user.name'], { encoding: 'utf8' });
    const name = (r.stdout || '').trim();
    if (name) return name;
  } catch {}
  return os.userInfo().username;
}

// Claude Code stores transcripts under ~/.claude/projects/<munged-project-path>/.
export function findLatestTranscript(projectRoot) {
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

// ---------- transcript parsing (best-effort; the JSONL format is internal to Claude Code) ----------
/** @returns {{doc: string, todos: Array<{content:string,status:string}>, turnCount: number}} */
export function parseTranscript(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const turns = [];
  let todos = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const role = rec.type === 'user' ? 'User' : rec.type === 'assistant' ? 'Assistant' : null;
    if (!role || !rec.message) continue;
    const content = rec.message.content;
    let text = '';
    if (typeof content === 'string') {
      text = content;
    } else if (Array.isArray(content)) {
      text = content
        .map((part) => {
          if (part && part.type === 'text') return part.text;
          if (part && part.type === 'tool_use') {
            // The most recent todo list is the departing session's working plan.
            if (part.name === 'TodoWrite' && part.input && Array.isArray(part.input.todos)) {
              todos = part.input.todos.map((t) => ({ content: String(t.content || ''), status: String(t.status || '') }));
            }
            return `[used tool ${part.name}]`;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
    }
    text = (text || '').trim();
    if (text) turns.push(`${role}: ${text}`);
  }
  return { doc: turns.join('\n\n'), todos, turnCount: turns.length };
}

// Keep the head (task framing) and the tail (conclusions) when the transcript is too large.
export function clip(doc, max) {
  if (doc.length <= max) return doc;
  const head = Math.floor(max * 0.2);
  const tail = max - head;
  return doc.slice(0, head) + '\n\n[…transcript truncated…]\n\n' + doc.slice(-tail);
}

// ---------- headless claude call ----------
// The claude CLI may be installed natively (~/.local/bin/claude[.exe]), via npm
// (%APPDATA%\npm\claude.cmd), or elsewhere on PATH — and hook processes sometimes
// run with a narrower PATH than the user's interactive shell.
export function resolveClaude(cfg = {}) {
  if (process.env.CCC_CLAUDE_BIN) return process.env.CCC_CLAUDE_BIN;
  if (cfg.claudeBin) return cfg.claudeBin;
  const isWin = process.platform === 'win32';
  const exts = isWin ? ['.exe', '.cmd', '.bat'] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, 'claude' + ext);
      try {
        if (fs.existsSync(p)) return p;
      } catch {}
    }
  }
  const fallbacks = isWin
    ? [
        path.join(os.homedir(), '.local', 'bin', 'claude.exe'),
        path.join(process.env.APPDATA || '', 'npm', 'claude.cmd'),
      ]
    : [
        path.join(os.homedir(), '.local', 'bin', 'claude'),
        '/usr/local/bin/claude',
        path.join(os.homedir(), '.npm-global', 'bin', 'claude'),
      ];
  for (const p of fallbacks) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

export function callClaude(prompt, cfg = {}) {
  return new Promise((resolve, reject) => {
    const bin = resolveClaude(cfg);
    if (!bin) {
      reject(new Error('claude CLI not found — add it to PATH, or set claudeBin in .claude/team/config.json or the CCC_CLAUDE_BIN env var'));
      return;
    }
    // Model comes from a repo-committed config file — sanitize before it can reach a shell.
    const model = /^[A-Za-z0-9.:_-]+$/.test(String(cfg.model || 'haiku')) ? String(cfg.model || 'haiku') : 'haiku';
    const timeoutMs = cfg.distillTimeoutMs || 300000;
    // .cmd/.bat cannot be spawned directly on Windows (EINVAL since the
    // CVE-2024-27980 patch); they need a shell. Real executables do not.
    const needsShell = /\.(cmd|bat)$/i.test(bin);
    const child = spawn(
      needsShell ? `"${bin}"` : bin,
      ['-p', '--model', model, '--output-format', 'text'],
      { shell: needsShell, windowsHide: true },
    );
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`claude call timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`claude exited ${code}: ${err.slice(0, 500)}`));
      else resolve(out);
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Pull the first JSON object out of model output (tolerates fences and prose). */
export function extractJsonObject(raw) {
  let s = String(raw).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1];
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object found in model output');
  return JSON.parse(s.slice(start, end + 1));
}

// ---------- redaction (defense in depth on top of prompt-level rules) ----------
const REDACTIONS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\b(?:sk|rk)-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED KEY]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED TOKEN]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED AWS KEY]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, '[REDACTED JWT]'],
  [/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+):([^@/\s]+)@/g, '$1:[REDACTED]@'],
  [/((?:api[_-]?key|secret|token|password|passwd)["']?\s*[:=]\s*["']?)([^\s"',;]{8,})/gi, '$1[REDACTED]'],
];

export function redact(s) {
  let out = String(s);
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
  return out;
}

export function redactDeep(v) {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]));
  return v;
}
