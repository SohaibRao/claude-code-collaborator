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
//   GET  /               team dashboard (static page; its data calls use the token)
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

// Embedded dashboard. Kept inside this file so the whole server deploys as one
// file (the Dockerfile copies only sync-server.mjs). The page itself is public;
// every data call it makes carries the Bearer token the viewer enters.
// NOTE for editors: the client script below deliberately avoids backticks and
// "${" so it can live inside this template literal.
const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ccc team dashboard</title>
<style>
  :root { --bg:#14161c; --panel:#1c1f28; --line:#2c3040; --ink:#e6e8ee; --mut:#8b93a7; --blue:#7d96f0; --copper:#e09258; --ok:#6fce8f; --bad:#e07a7a; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 ui-monospace,Consolas,monospace; }
  header { display:flex; align-items:center; gap:12px; padding:14px 20px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  header h1 { font-size:15px; margin:0; letter-spacing:.06em; }
  header h1 b { color:var(--blue); }
  #dot { width:9px; height:9px; border-radius:50%; background:var(--mut); }
  #dot.ok { background:var(--ok); } #dot.bad { background:var(--bad); }
  #state { color:var(--mut); font-size:12px; }
  #tok { margin-left:auto; display:flex; gap:6px; }
  #tok input { background:var(--panel); border:1px solid var(--line); color:var(--ink); padding:4px 8px; border-radius:6px; font:inherit; width:180px; }
  #tok button { background:var(--blue); border:0; color:#10131b; padding:4px 12px; border-radius:6px; font:inherit; cursor:pointer; font-weight:700; }
  main { max-width:900px; margin:0 auto; padding:20px; display:grid; gap:24px; }
  h2 { font-size:12px; letter-spacing:.14em; text-transform:uppercase; color:var(--mut); margin:0 0 10px; }
  h2 .n { color:var(--copper); }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:12px 16px; margin-bottom:8px; }
  .card .who { color:var(--blue); font-weight:700; }
  .card .task { color:var(--ink); }
  .card .meta { color:var(--mut); font-size:12px; margin-top:4px; overflow-wrap:anywhere; }
  .card .repo { color:var(--copper); }
  .empty { color:var(--mut); padding:8px 2px; }
  .hf .who { color:var(--copper); }
  .hf code { background:var(--bg); padding:1px 6px; border-radius:5px; }
</style>
</head>
<body>
<header>
  <div id="dot"></div>
  <h1><b>ccc</b> team dashboard</h1>
  <span id="state">connecting…</span>
  <div id="tok"><input id="token" type="password" placeholder="server token"><button id="save">connect</button></div>
</header>
<main>
  <section><h2>Active sessions <span class="n" id="nsess"></span></h2><div id="sessions"></div></section>
  <section><h2>Handoff inbox <span class="n" id="nhf"></span></h2><div id="handoffs"></div></section>
</main>
<script>
(function () {
  var tokenEl = document.getElementById('token');
  var dot = document.getElementById('dot');
  var state = document.getElementById('state');
  tokenEl.value = localStorage.getItem('ccc-token') || '';
  document.getElementById('save').onclick = function () {
    localStorage.setItem('ccc-token', tokenEl.value);
    tick();
  };
  function hdrs() {
    var t = localStorage.getItem('ccc-token') || '';
    return t ? { authorization: 'Bearer ' + t } : {};
  }
  function age(s) {
    if (s < 90) return s + 's';
    if (s < 5400) return Math.round(s / 60) + 'm';
    if (s < 129600) return Math.round(s / 3600) + 'h';
    return Math.round(s / 86400) + 'd';
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function renderSessions(list) {
    var box = document.getElementById('sessions');
    box.replaceChildren();
    document.getElementById('nsess').textContent = '· ' + list.length;
    if (!list.length) { box.append(el('div', 'empty', 'No active sessions.')); return; }
    list.forEach(function (s) {
      var c = el('div', 'card');
      var top = el('div');
      top.append(el('span', 'who', s.user));
      top.append(el('span', 'repo', '  ' + (s.repo || '')));
      if (s.task) top.append(el('span', 'task', ' — ' + s.task));
      c.append(top);
      var files = (s.recentFiles || []).map(function (f) { return f.path; }).join(', ');
      c.append(el('div', 'meta', 'idle ' + age(s.idleSeconds) + (files ? ' · recent: ' + files : '')));
      box.append(c);
    });
  }
  function renderHandoffs(list) {
    var box = document.getElementById('handoffs');
    box.replaceChildren();
    document.getElementById('nhf').textContent = '· ' + list.length;
    if (!list.length) { box.append(el('div', 'empty', 'No handoffs waiting.')); return; }
    list.forEach(function (h) {
      var c = el('div', 'card hf');
      var top = el('div');
      top.append(el('span', 'who', h.from));
      top.append(el('span', 'repo', '  ' + (h.repo || '')));
      top.append(el('span', 'task', ' — ' + h.title));
      c.append(top);
      var meta = el('div', 'meta', age(Math.round((Date.now() - h.createdAt) / 1000)) + ' ago · resume with ');
      var code = document.createElement('code');
      code.textContent = 'ccc resume ' + h.id;
      meta.append(code);
      c.append(meta);
      box.append(c);
    });
  }
  async function tick() {
    try {
      var a = await fetch('/activity', { headers: hdrs() });
      if (a.status === 401) {
        dot.className = 'bad';
        state.textContent = 'unauthorized — enter the server token';
        return;
      }
      var act = await a.json();
      var hf = await (await fetch('/handoffs', { headers: hdrs() })).json();
      renderSessions(act.sessions || []);
      renderHandoffs(hf.handoffs || []);
      dot.className = 'ok';
      state.textContent = 'live · refreshes every 5s';
    } catch (e) {
      dot.className = 'bad';
      state.textContent = 'server unreachable';
    }
  }
  setInterval(tick, 5000);
  tick();
})();
</script>
</body>
</html>`;

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
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(DASHBOARD_HTML);
      }
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
