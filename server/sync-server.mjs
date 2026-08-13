#!/usr/bin/env node
// Claude Code Collaborator — sync server (Phase 2: presence & coordination).
// A deliberately small, zero-dependency REST service. Teams run it anywhere
// reachable by all developers (LAN, VPN, a $5 VM):
//
//   node server/sync-server.mjs --port 7377 [--token <shared-secret>] [--state <file>]
//   (or: ccc serve --port 7377)
//
// Endpoints (JSON):
//   POST /events         body: event or {events:[...]} — see EVENT TYPES below
//   GET  /activity       ?repo=  → active sessions with tasks + recent files
//   GET  /file-activity  ?path=&repo=&exclude=&window=1800 → who touched a file recently
//   POST /handoffs       body: handoff bundle (id, repo, from, title, ...)
//   GET  /handoffs       ?repo=  → bundle metadata list (newest first)
//   GET  /handoffs/<id>  → full bundle
//   GET  /healthz
//
// EVENT TYPES: session_start | session_end | file_touch | task
// Common fields: sessionId, user, repo, ts (server time wins). file_touch: path. task: task.
//
// Presence data is advisory and ephemeral. State is held in memory with an
// optional JSON snapshot so restarts don't blank the team's view.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const IDLE_EXPIRY_MS = 2 * 60 * 60 * 1000; // sessions unseen for 2h are dropped
const DEFAULT_FILE_WINDOW_S = 1800; // "recently touched" = last 30 minutes
const SNAPSHOT_INTERVAL_MS = 30_000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_SESSIONS = 5000;
const MAX_FILES_PER_SESSION = 500;
const MAX_HANDOFFS = 500;
const HANDOFF_TTL_MS = 14 * 24 * 60 * 60 * 1000; // handoffs expire after 14 days
const HANDOFF_ID_RE = /^[A-Za-z0-9-]{4,64}$/;

export function createSyncServer(opts = {}) {
  const token = opts.token ?? process.env.CCC_SYNC_TOKEN ?? '';
  const stateFile = opts.stateFile ?? '';
  /** @type {Map<string, {user:string, repo:string, startedAt:number, lastSeen:number, task:string, ended:boolean, files:Record<string,number>}>} */
  let sessions = new Map();
  /** @type {Map<string, object>} handoff id → bundle (with storedAt) */
  let handoffs = new Map();
  let dirty = false;

  if (stateFile && fs.existsSync(stateFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      sessions = new Map(Object.entries(raw.sessions || {}));
      handoffs = new Map(Object.entries(raw.handoffs || {}));
    } catch {}
  }

  function snapshot() {
    if (!stateFile || !dirty) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      fs.writeFileSync(
        stateFile,
        JSON.stringify({ sessions: Object.fromEntries(sessions), handoffs: Object.fromEntries(handoffs) }),
      );
      dirty = false;
    } catch {}
  }

  function gc(now) {
    for (const [id, s] of sessions) {
      if (now - s.lastSeen > IDLE_EXPIRY_MS) sessions.delete(id);
    }
    for (const [id, h] of handoffs) {
      if (now - (h.storedAt || 0) > HANDOFF_TTL_MS) handoffs.delete(id);
    }
  }

  function handleEvent(ev, now) {
    const id = String(ev.sessionId || '');
    const type = String(ev.type || '');
    if (!id || !type) return null;
    let s = sessions.get(id);
    if (!s) {
      if (sessions.size >= MAX_SESSIONS) gc(now);
      s = { user: '', repo: '', startedAt: now, lastSeen: now, task: '', ended: false, files: {} };
      sessions.set(id, s);
    }
    s.lastSeen = now;
    // First non-empty identity wins: sessions are keyed by id and never change
    // owners, so a mislabeled later event cannot rename someone else's session.
    if (ev.user && !s.user) s.user = String(ev.user).slice(0, 100);
    if (ev.repo && !s.repo) s.repo = String(ev.repo).slice(0, 200);
    let reply = { ok: true };
    switch (type) {
      case 'session_start':
        s.startedAt = now;
        s.ended = false;
        break;
      case 'session_end':
        s.ended = true;
        break;
      case 'file_touch': {
        if (!ev.path) return null;
        const p = String(ev.path).slice(0, 500);
        // Answer "who else is in this file?" in the same round trip.
        reply.conflicts = fileActivity(p, s.repo, id, DEFAULT_FILE_WINDOW_S, now);
        s.files[p] = now;
        const keys = Object.keys(s.files);
        if (keys.length > MAX_FILES_PER_SESSION) {
          keys.sort((a, b) => s.files[a] - s.files[b]);
          for (const k of keys.slice(0, keys.length - MAX_FILES_PER_SESSION)) delete s.files[k];
        }
        break;
      }
      case 'task':
        s.task = String(ev.task || '').slice(0, 300);
        break;
      default:
        return null;
    }
    dirty = true;
    return reply;
  }

  function fileActivity(p, repo, excludeSession, windowS, now) {
    const cutoff = now - windowS * 1000;
    const hits = [];
    for (const [id, s] of sessions) {
      if (id === excludeSession) continue;
      if (repo && s.repo && s.repo !== repo) continue;
      const ts = s.files[p];
      if (ts && ts >= cutoff) {
        hits.push({ sessionId: id.slice(0, 8), user: s.user || 'unknown', ageSeconds: Math.round((now - ts) / 1000), sessionEnded: s.ended });
      }
    }
    hits.sort((a, b) => a.ageSeconds - b.ageSeconds);
    return hits;
  }

  function activity(repo, now) {
    gc(now);
    const out = [];
    for (const [id, s] of sessions) {
      if (s.ended) continue;
      if (repo && s.repo && s.repo !== repo) continue;
      const recentFiles = Object.entries(s.files)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([p, ts]) => ({ path: p, ageSeconds: Math.round((now - ts) / 1000) }));
      out.push({
        sessionId: id.slice(0, 8),
        user: s.user || 'unknown',
        repo: s.repo,
        task: s.task,
        startedAt: s.startedAt,
        idleSeconds: Math.round((now - s.lastSeen) / 1000),
        recentFiles,
      });
    }
    out.sort((a, b) => a.idleSeconds - b.idleSeconds);
    return out;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const send = (code, obj) => {
      const body = JSON.stringify(obj);
      res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/healthz') return send(200, { ok: true, sessions: sessions.size });
      if (token) {
        const auth = req.headers['authorization'] || '';
        if (auth !== `Bearer ${token}`) return send(401, { error: 'unauthorized' });
      }
      const now = Date.now();
      if (req.method === 'POST' && url.pathname === '/events') {
        let body;
        try {
          body = JSON.parse((await readBody(req)) || '{}');
        } catch {
          return send(400, { error: 'invalid JSON' });
        }
        const events = Array.isArray(body.events) ? body.events : [body];
        let last = null;
        let accepted = 0;
        for (const ev of events) {
          const r = handleEvent(ev, now);
          if (r) {
            accepted++;
            last = r;
          }
        }
        if (!accepted) return send(400, { error: 'no valid events' });
        return send(200, { ok: true, accepted, ...(last && last.conflicts ? { conflicts: last.conflicts } : {}) });
      }
      if (req.method === 'GET' && url.pathname === '/activity') {
        return send(200, { sessions: activity(url.searchParams.get('repo') || '', now) });
      }
      if (req.method === 'GET' && url.pathname === '/file-activity') {
        const p = url.searchParams.get('path') || '';
        if (!p) return send(400, { error: 'path required' });
        const windowS = Math.min(24 * 3600, Number(url.searchParams.get('window')) || DEFAULT_FILE_WINDOW_S);
        return send(200, {
          activity: fileActivity(p, url.searchParams.get('repo') || '', url.searchParams.get('exclude') || '', windowS, now),
        });
      }
      if (req.method === 'POST' && url.pathname === '/handoffs') {
        let bundle;
        try {
          bundle = JSON.parse((await readBody(req)) || '{}');
        } catch {
          return send(400, { error: 'invalid JSON' });
        }
        if (!HANDOFF_ID_RE.test(String(bundle.id || '')) || !bundle.repo) {
          return send(400, { error: 'bundle needs a valid id and a repo' });
        }
        gc(now);
        if (handoffs.size >= MAX_HANDOFFS && !handoffs.has(bundle.id)) {
          // Drop the oldest to make room — handoffs are transient by nature.
          const oldest = [...handoffs.entries()].sort((a, b) => (a[1].storedAt || 0) - (b[1].storedAt || 0))[0];
          if (oldest) handoffs.delete(oldest[0]);
        }
        handoffs.set(bundle.id, { ...bundle, storedAt: now });
        dirty = true;
        return send(200, { ok: true, id: bundle.id });
      }
      if (req.method === 'GET' && url.pathname.startsWith('/handoffs/')) {
        const id = decodeURIComponent(url.pathname.slice('/handoffs/'.length));
        const bundle = handoffs.get(id);
        return bundle ? send(200, bundle) : send(404, { error: 'handoff not found' });
      }
      if (req.method === 'GET' && url.pathname === '/handoffs') {
        gc(now);
        const repo = url.searchParams.get('repo') || '';
        const list = [...handoffs.values()]
          .filter((h) => !repo || h.repo === repo)
          .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
          .slice(0, 50)
          .map((h) => ({ id: h.id, repo: h.repo, from: h.from, title: h.title, createdAt: h.createdAt }));
        return send(200, { handoffs: list });
      }
      send(404, { error: 'not found' });
    } catch (e) {
      send(500, { error: String(e && e.message ? e.message : e) });
    }
  });

  const timer = setInterval(snapshot, SNAPSHOT_INTERVAL_MS);
  timer.unref();

  return {
    server,
    listen: (port, host) =>
      new Promise((resolve) => server.listen(port ?? 0, host ?? '0.0.0.0', () => resolve(server.address()))),
    close: () =>
      new Promise((resolve) => {
        clearInterval(timer);
        snapshot();
        server.close(resolve);
      }),
  };
}

// ---------- CLI entry ----------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) args[argv[i].slice(2)] = argv[i + 1];
  }
  const port = args.port !== undefined ? Number(args.port) : 7377;
  const svc = createSyncServer({ token: args.token, stateFile: args.state });
  svc.listen(port).then((addr) => {
    console.log(`ccc sync server listening on :${addr.port}${args.token || process.env.CCC_SYNC_TOKEN ? ' (token auth on)' : ' (NO AUTH — use --token on anything beyond localhost)'}`);
  });
  const stop = async () => {
    await svc.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
