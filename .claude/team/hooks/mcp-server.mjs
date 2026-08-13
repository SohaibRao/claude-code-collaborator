#!/usr/bin/env node
// Claude Code Collaborator — team-context MCP server.
// Minimal JSON-RPC 2.0 over stdio (newline-delimited), zero dependencies.
// Registered in .mcp.json by `ccc init`. Tools:
//   search_team_memory  — local full-text search over .claude/team/ entries
//   get_team_activity   — live teammate sessions (requires presence.url in config)
//   check_file_activity — who touched a file recently (requires presence.url)
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { findTeamDir, readJson } from './common.mjs';
import { presenceConfig, getActivity, getFileActivity, listHandoffs, formatAge } from './presence.mjs';

const team = findTeamDir(process.cwd());

const TOOLS = [
  {
    name: 'search_team_memory',
    description:
      "Full-text search the team's shared memory (.claude/team/): decisions, knowledge, and session journals distilled from every developer's Claude Code sessions. Use before making architectural choices to check for existing decisions and known gotchas.",
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Words or phrase to search for (case-insensitive)' } },
      required: ['query'],
    },
  },
  {
    name: 'get_team_activity',
    description:
      'List teammates with active Claude Code sessions on this project right now — who they are, what they are working on, and which files they touched recently. Requires the team sync server (presence) to be configured.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'check_file_activity',
    description:
      'Check whether another developer\'s session touched a specific file recently (default window 30 minutes). Use before large refactors to avoid colliding with in-flight work. Requires the team sync server (presence) to be configured.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Repo-relative file path, forward slashes' } },
      required: ['path'],
    },
  },
  {
    name: 'list_handoffs',
    description:
      'List work handoffs available for this project — in-flight tasks packaged by other developers for someone to continue (from .claude/team/handoffs/ and the sync server if configured). The user can resume one with `ccc resume <id>`.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

function searchTeamMemory(query) {
  if (!team) return 'No .claude/team directory found — run `ccc init` first.';
  const q = String(query || '').toLowerCase();
  if (!q) return 'Empty query.';
  const results = [];
  for (const sub of ['decisions', 'knowledge', 'journal']) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(team, sub)).filter((f) => f.endsWith('.md'));
    } catch {}
    for (const f of files) {
      const full = path.join(team, sub, f);
      let raw = '';
      try {
        raw = fs.readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      if (!raw.toLowerCase().includes(q)) continue;
      const lines = raw.split(/\r?\n/);
      const hits = lines.filter((l) => l.toLowerCase().includes(q)).slice(0, 4);
      results.push(`### .claude/team/${sub}/${f}\n${hits.map((h) => `> ${h.trim()}`).join('\n')}`);
      if (results.length >= 20) break;
    }
  }
  return results.length
    ? `${results.length} matching entr(y/ies):\n\n${results.join('\n\n')}\n\nRead the full files for detail.`
    : `No team memory entries match "${query}".`;
}

async function callTool(name, args) {
  if (name === 'search_team_memory') return searchTeamMemory(args.query);

  if (!team) return 'No .claude/team directory found — run `ccc init` first.';

  if (name === 'list_handoffs') {
    const rows = new Map();
    try {
      const dir = path.join(team, 'handoffs');
      for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
        const b = readJson(path.join(dir, f));
        if (b && b.id) rows.set(b.id, b);
      }
    } catch {}
    const pcfg = presenceConfig(team);
    if (pcfg.enabled) {
      const res = await listHandoffs(pcfg, team);
      for (const b of (res && res.handoffs) || []) if (!rows.has(b.id)) rows.set(b.id, b);
    }
    if (!rows.size) return 'No handoffs available for this project.';
    return [...rows.values()]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map((b) => `- ${b.id} — "${b.title}" from ${b.from} (${formatAge(Math.round((Date.now() - b.createdAt) / 1000))}) — resume with \`ccc resume ${b.id}\``)
      .join('\n');
  }

  const cfg = presenceConfig(team);
  if (!cfg.enabled) {
    return 'Team presence is not configured. Set presence.url in .claude/team/config.json (a running `ccc serve` instance) to enable live activity queries.';
  }

  if (name === 'get_team_activity') {
    const act = await getActivity(cfg, team);
    if (!act) return 'Sync server unreachable right now.';
    if (!act.sessions.length) return 'No active teammate sessions on this project.';
    return act.sessions
      .map((s) => {
        const files = (s.recentFiles || []).map((f) => f.path).join(', ');
        return `- ${s.user} (session ${s.sessionId}, idle ${s.idleSeconds}s)${s.task ? ` — task: ${s.task}` : ''}${files ? ` — recent files: ${files}` : ''}`;
      })
      .join('\n');
  }

  if (name === 'check_file_activity') {
    const rel = String(args.path || '').replace(/\\/g, '/');
    if (!rel) return 'path is required.';
    const res = await getFileActivity(cfg, team, rel, '');
    if (!res) return 'Sync server unreachable right now.';
    if (!res.activity.length) return `No recent activity on ${rel} by any session.`;
    return res.activity
      .map((a) => `- ${a.user} touched ${rel} ${a.ageSeconds}s ago${a.sessionEnded ? ' (session since ended)' : ' (session ACTIVE)'}`)
      .join('\n');
  }

  throw new Error(`unknown tool: ${name}`);
}

// ---------- JSON-RPC over stdio ----------
const rl = readline.createInterface({ input: process.stdin, terminal: false });
const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');

rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params = {} } = msg;
  if (id === undefined || id === null) return; // notification — nothing to answer

  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'ccc-team-context', version: '0.4.0' },
        },
      });
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    } else if (method === 'tools/call') {
      const text = await callTool(params.name, params.arguments || {});
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(text) }], isError: false } });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (e) {
    send({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `error: ${e && e.message ? e.message : e}` }], isError: true },
    });
  }
});
