#!/usr/bin/env node
// Claude Code Collaborator — live session server (Phase 4b, companion package).
// One server-hosted Claude agent per "room"; any number of humans watch the same
// transcript stream and steer it together. The agent runs via the Claude Agent
// SDK on this machine's existing Claude auth — which is why this lives in its
// own package (ccc-live) instead of the zero-dependency core.
//
//   node live-server.mjs --port 7378 [--token <secret>] [--cwd <project>] [--model <m>] [--mock]
//   (or: ccc live -- from the ccc CLI when this package sits alongside it)
//
// Endpoints (Bearer token auth like the sync server; SSE also accepts ?token=):
//   GET  /                     embedded UI
//   GET  /rooms                list rooms
//   POST /rooms                {title} → create room + start its agent
//   GET  /rooms/<id>           room info + buffered transcript events
//   POST /rooms/<id>/messages  {from, text} → steer the agent
//   POST /rooms/<id>/end       end the room's agent session
//   GET  /rooms/<id>/stream    SSE: replay buffer, then live events
//   GET  /healthz
//
// --mock replaces the SDK with a canned agent (used by tests; no auth, no network).
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_EVENTS = 500;
const MAX_BODY_BYTES = 64 * 1024;

class Room {
  constructor(id, title) {
    this.id = id;
    this.title = title;
    this.createdAt = Date.now();
    this.status = 'starting';
    this.events = [];
    this.clients = new Set();
    this.pendingMsgs = [];
    this.waiters = [];
    this.turns = 0;
  }

  push(event) {
    const e = { ...event, ts: Date.now() };
    this.events.push(e);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    const line = `data: ${JSON.stringify(e)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(line);
      } catch {}
    }
  }

  post(from, text) {
    this.turns++;
    this.push({ type: 'user', from, text });
    const msg = { from, text };
    const w = this.waiters.shift();
    if (w) w(msg);
    else this.pendingMsgs.push(msg);
  }

  nextMessage() {
    if (this.status === 'ended') return Promise.resolve(null);
    if (this.pendingMsgs.length) return Promise.resolve(this.pendingMsgs.shift());
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  end() {
    if (this.status === 'ended') return;
    this.status = 'ended';
    this.push({ type: 'status', text: 'session ended' });
    for (const w of this.waiters.splice(0)) w(null);
    for (const res of this.clients) {
      try {
        res.end();
      } catch {}
    }
    this.clients.clear();
  }
}

// ---------- agent runners ----------
async function runMockAgent(room) {
  room.status = 'running';
  room.push({ type: 'status', text: 'mock agent ready (no SDK, no API calls)' });
  while (true) {
    const msg = await room.nextMessage();
    if (!msg) return;
    await new Promise((r) => setTimeout(r, 30));
    room.push({ type: 'assistant', text: `mock: acknowledged "${msg.text}" from ${msg.from}` });
  }
}

async function runSdkAgent(room, opts) {
  let sdk;
  try {
    sdk = await import('@anthropic-ai/claude-agent-sdk');
  } catch {
    room.push({ type: 'status', text: 'Agent SDK not installed — run `npm install` in the ccc live/ directory. Falling back to mock agent.' });
    return runMockAgent(room);
  }

  // Everyone's steering messages funnel into one streaming-input generator,
  // attributed inline so the agent knows who asked for what.
  async function* input() {
    while (true) {
      const msg = await room.nextMessage();
      if (!msg) return;
      yield {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: `[${msg.from}] ${msg.text}` }] },
      };
    }
  }

  try {
    const q = sdk.query({
      prompt: input(),
      options: {
        cwd: opts.cwd,
        // Shared sessions act on a real checkout — auto-accept edits, but never
        // bypass permissions wholesale.
        permissionMode: 'acceptEdits',
        ...(opts.model ? { model: opts.model } : {}),
      },
    });
    room.q = q;
    room.status = 'running';
    for await (const m of q) {
      if (m.type === 'system' && m.subtype === 'init') {
        room.push({ type: 'status', text: `agent session started · model ${m.model} · cwd ${opts.cwd}` });
      } else if (m.type === 'assistant') {
        for (const part of m.message.content || []) {
          if (part.type === 'text' && part.text) room.push({ type: 'assistant', text: part.text });
          else if (part.type === 'tool_use') room.push({ type: 'tool', name: part.name });
        }
      } else if (m.type === 'result') {
        const cost = typeof m.total_cost_usd === 'number' ? ` · $${m.total_cost_usd.toFixed(4)}` : '';
        room.push({ type: 'status', text: `turn complete${cost}` });
      }
    }
  } catch (e) {
    room.status = 'error';
    room.push({ type: 'status', text: `agent error: ${e && e.message ? e.message : e}` });
  }
}

// ---------- embedded UI ----------
// NOTE for editors: the client script avoids backticks and "${" so it can live
// inside this template literal.
const UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ccc live sessions</title>
<style>
  :root { --bg:#14161c; --panel:#1c1f28; --line:#2c3040; --ink:#e6e8ee; --mut:#8b93a7; --blue:#7d96f0; --copper:#e09258; --ok:#6fce8f; --bad:#e07a7a; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 ui-monospace,Consolas,monospace; height:100vh; display:flex; flex-direction:column; }
  header { display:flex; align-items:center; gap:12px; padding:12px 20px; border-bottom:1px solid var(--line); flex-wrap:wrap; }
  header h1 { font-size:15px; margin:0; letter-spacing:.06em; } header h1 b { color:var(--copper); }
  #state { color:var(--mut); font-size:12px; }
  #tok { margin-left:auto; display:flex; gap:6px; }
  input, button { font:inherit; }
  input { background:var(--panel); border:1px solid var(--line); color:var(--ink); padding:4px 8px; border-radius:6px; }
  button { background:var(--copper); border:0; color:#10131b; padding:4px 12px; border-radius:6px; cursor:pointer; font-weight:700; }
  #layout { display:flex; flex:1; min-height:0; }
  #side { width:250px; border-right:1px solid var(--line); padding:14px; overflow-y:auto; }
  #side h2 { font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--mut); margin:0 0 8px; }
  .roomBtn { display:block; width:100%; text-align:left; background:var(--panel); color:var(--ink); border:1px solid var(--line); border-radius:8px; padding:8px 10px; margin-bottom:6px; cursor:pointer; font-weight:400; }
  .roomBtn.active { border-color:var(--copper); }
  .roomBtn .st { color:var(--mut); font-size:11px; display:block; }
  #newRoom { display:flex; gap:6px; margin-top:10px; } #newRoom input { flex:1; min-width:0; }
  #main { flex:1; display:flex; flex-direction:column; min-width:0; }
  #feed { flex:1; overflow-y:auto; padding:16px 20px; display:flex; flex-direction:column; gap:8px; }
  .ev { max-width:72ch; overflow-wrap:anywhere; }
  .ev .who { font-weight:700; }
  .ev.user .who { color:var(--blue); }
  .ev.assistant .who { color:var(--copper); }
  .ev.tool, .ev.status { color:var(--mut); font-size:12px; }
  #composer { display:flex; gap:8px; padding:12px 20px; border-top:1px solid var(--line); }
  #name { width:120px; } #msg { flex:1; min-width:0; }
  .hint { color:var(--mut); padding:20px; }
</style>
</head>
<body>
<header>
  <h1><b>ccc</b> live sessions</h1>
  <span id="state">connecting…</span>
  <div id="tok"><input id="token" type="password" placeholder="server token"><button id="save">connect</button></div>
</header>
<div id="layout">
  <aside id="side">
    <h2>Rooms</h2>
    <div id="rooms"></div>
    <div id="newRoom"><input id="newTitle" placeholder="new room title"><button id="create">+</button></div>
  </aside>
  <section id="main">
    <div id="feed"><div class="hint">Pick a room, or create one. Everyone connected sees the same agent and can steer it.</div></div>
    <div id="composer">
      <input id="name" placeholder="your name">
      <input id="msg" placeholder="steer the agent…">
      <button id="send">send</button>
    </div>
  </section>
</div>
<script>
(function () {
  var current = null, es = null;
  var state = document.getElementById('state');
  var tokenEl = document.getElementById('token');
  var nameEl = document.getElementById('name');
  tokenEl.value = localStorage.getItem('ccc-token') || '';
  nameEl.value = localStorage.getItem('ccc-name') || '';
  function token() { return localStorage.getItem('ccc-token') || ''; }
  function hdrs(json) {
    var h = token() ? { authorization: 'Bearer ' + token() } : {};
    if (json) h['content-type'] = 'application/json';
    return h;
  }
  document.getElementById('save').onclick = function () { localStorage.setItem('ccc-token', tokenEl.value); loadRooms(); };

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function addEvent(e) {
    var feed = document.getElementById('feed');
    var d = el('div', 'ev ' + e.type);
    if (e.type === 'user') { d.append(el('span', 'who', (e.from || 'someone') + ': '), document.createTextNode(e.text)); }
    else if (e.type === 'assistant') { d.append(el('span', 'who', 'claude: '), document.createTextNode(e.text)); }
    else if (e.type === 'tool') { d.textContent = '[tool] ' + e.name; }
    else { d.textContent = '· ' + e.text; }
    feed.append(d);
    feed.scrollTop = feed.scrollHeight;
  }
  function join(id) {
    current = id;
    if (es) es.close();
    document.getElementById('feed').replaceChildren();
    es = new EventSource('/rooms/' + id + '/stream?token=' + encodeURIComponent(token()));
    es.onmessage = function (m) { addEvent(JSON.parse(m.data)); };
    es.onerror = function () { state.textContent = 'stream disconnected — retrying'; };
    es.onopen = function () { state.textContent = 'live · room ' + id; };
    loadRooms();
  }
  async function loadRooms() {
    try {
      var r = await fetch('/rooms', { headers: hdrs() });
      if (r.status === 401) { state.textContent = 'unauthorized — enter the server token'; return; }
      var data = await r.json();
      var box = document.getElementById('rooms');
      box.replaceChildren();
      data.rooms.forEach(function (room) {
        var b = el('button', 'roomBtn' + (room.id === current ? ' active' : ''));
        b.append(el('span', null, room.title));
        b.append(el('span', 'st', room.id + ' · ' + room.status + ' · ' + room.viewers + ' watching'));
        b.onclick = function () { join(room.id); };
        box.append(b);
      });
      if (!current) state.textContent = data.rooms.length ? 'pick a room' : 'no rooms yet — create one';
    } catch (e) { state.textContent = 'server unreachable'; }
  }
  document.getElementById('create').onclick = async function () {
    var t = document.getElementById('newTitle').value.trim() || 'shared session';
    var r = await fetch('/rooms', { method: 'POST', headers: hdrs(true), body: JSON.stringify({ title: t }) });
    if (r.ok) { var d = await r.json(); document.getElementById('newTitle').value = ''; join(d.id); }
  };
  async function send() {
    if (!current) return;
    var msg = document.getElementById('msg');
    var text = msg.value.trim();
    if (!text) return;
    localStorage.setItem('ccc-name', nameEl.value);
    await fetch('/rooms/' + current + '/messages', {
      method: 'POST', headers: hdrs(true),
      body: JSON.stringify({ from: nameEl.value.trim() || 'anonymous', text: text }),
    });
    msg.value = '';
  }
  document.getElementById('send').onclick = send;
  document.getElementById('msg').addEventListener('keydown', function (e) { if (e.key === 'Enter') send(); });
  setInterval(loadRooms, 5000);
  loadRooms();
})();
</script>
</body>
</html>`;

// ---------- HTTP server ----------
export function createLiveServer(opts = {}) {
  const token = opts.token ?? process.env.CCC_LIVE_TOKEN ?? '';
  const cwd = opts.cwd || process.cwd();
  const mock = Boolean(opts.mock);
  /** @type {Map<string, Room>} */
  const rooms = new Map();

  function authed(req, url) {
    if (!token) return true;
    if ((req.headers['authorization'] || '') === `Bearer ${token}`) return true;
    return url.searchParams.get('token') === token;
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
      if (url.pathname === '/healthz') return send(200, { ok: true, rooms: rooms.size });
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(UI_HTML);
      }
      if (!authed(req, url)) return send(401, { error: 'unauthorized' });

      if (req.method === 'GET' && url.pathname === '/rooms') {
        return send(200, {
          rooms: [...rooms.values()].map((r) => ({
            id: r.id,
            title: r.title,
            status: r.status,
            viewers: r.clients.size,
            turns: r.turns,
            createdAt: r.createdAt,
          })),
        });
      }
      if (req.method === 'POST' && url.pathname === '/rooms') {
        let body = {};
        try {
          body = JSON.parse((await readBody(req)) || '{}');
        } catch {}
        const id = `rm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const room = new Room(id, String(body.title || 'shared session').slice(0, 120));
        rooms.set(id, room);
        (mock ? runMockAgent(room) : runSdkAgent(room, { cwd, model: opts.model })).finally(() => room.end());
        return send(200, { id });
      }

      const m = url.pathname.match(/^\/rooms\/([A-Za-z0-9-]+)(\/(messages|stream|end))?$/);
      if (m) {
        const room = rooms.get(m[1]);
        if (!room) return send(404, { error: 'room not found' });
        const sub = m[3] || '';
        if (req.method === 'GET' && !sub) {
          return send(200, { id: room.id, title: room.title, status: room.status, events: room.events });
        }
        if (req.method === 'POST' && sub === 'messages') {
          let body = {};
          try {
            body = JSON.parse((await readBody(req)) || '{}');
          } catch {}
          if (!body.text) return send(400, { error: 'text required' });
          if (room.status === 'ended') return send(409, { error: 'room has ended' });
          room.post(String(body.from || 'anonymous').slice(0, 60), String(body.text).slice(0, 8000));
          return send(200, { ok: true });
        }
        if (req.method === 'POST' && sub === 'end') {
          room.end();
          return send(200, { ok: true });
        }
        if (req.method === 'GET' && sub === 'stream') {
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          res.write('retry: 3000\n\n');
          for (const e of room.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
          room.clients.add(res);
          req.on('close', () => room.clients.delete(res));
          return;
        }
      }
      send(404, { error: 'not found' });
    } catch (e) {
      send(500, { error: String(e && e.message ? e.message : e) });
    }
  });

  return {
    server,
    listen: (port, host) =>
      new Promise((resolve) => server.listen(port ?? 0, host ?? '0.0.0.0', () => resolve(server.address()))),
    close: () =>
      new Promise((resolve) => {
        for (const r of rooms.values()) r.end();
        server.close(resolve);
      }),
  };
}

// ---------- CLI entry ----------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    if (key === 'mock') args.mock = true;
    else args[key] = argv[++i];
  }
  const port = args.port !== undefined ? Number(args.port) : 7378;
  const svc = createLiveServer({
    token: args.token,
    cwd: args.cwd ? path.resolve(args.cwd) : process.cwd(),
    model: args.model,
    mock: args.mock,
  });
  svc.listen(port).then((addr) => {
    console.log(
      `ccc live server listening on :${addr.port}${args.mock ? ' (mock mode)' : ''}${args.token || process.env.CCC_LIVE_TOKEN ? ' (token auth on)' : ' (NO AUTH — use --token on anything beyond localhost)'}`,
    );
  });
  const stop = async () => {
    await svc.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
