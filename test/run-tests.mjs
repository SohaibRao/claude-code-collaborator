// Smoke tests for Claude Code Collaborator. Zero-dependency, runs with `npm test`.
// Uses --mock / CCC_MOCK_DISTILL so no Claude call (and no cost) is involved.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pkgRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ccc = path.join(pkgRoot, 'bin', 'ccc.mjs');
const fixture = path.join(pkgRoot, 'test', 'fixtures', 'sample-transcript.jsonl');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-test-'));
// Mark tmp as a project root the way real projects are — findProjectRoot anchors on .git.
fs.mkdirSync(path.join(tmp, '.git'));
const team = path.join(tmp, '.claude', 'team');

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL  ${name}\n      ${e.message}`);
  }
}

const run = (argv, opts = {}) =>
  spawnSync(process.execPath, argv, { cwd: tmp, encoding: 'utf8', ...opts });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 1. init ----
{
  const r = run([ccc, 'init']);
  check('init exits 0', () => assert.equal(r.status, 0, r.stderr));
  check('init creates team directories', () => {
    for (const sub of ['decisions', 'knowledge', 'journal', 'hooks']) {
      assert.ok(fs.existsSync(path.join(team, sub)), `missing ${sub}`);
    }
    assert.ok(fs.existsSync(path.join(team, 'INDEX.md')));
    assert.ok(fs.existsSync(path.join(team, 'config.json')));
  });
  check('init vendors hook scripts', () => {
    for (const f of ['session-start.mjs', 'session-end.mjs', 'distill.mjs', 'presence.mjs', 'post-tool.mjs', 'mcp-server.mjs']) {
      assert.ok(fs.existsSync(path.join(team, 'hooks', f)), `missing ${f}`);
    }
  });
  check('init registers hooks in settings.json', () => {
    const settings = JSON.parse(fs.readFileSync(path.join(tmp, '.claude', 'settings.json'), 'utf8'));
    assert.equal(settings.hooks.SessionStart.length, 1);
    assert.equal(settings.hooks.SessionEnd.length, 1);
    assert.equal(settings.hooks.PostToolUse.length, 1);
    assert.equal(settings.hooks.PostToolUse[0].matcher, 'Write|Edit|NotebookEdit');
    assert.match(settings.hooks.SessionStart[0].hooks[0].command, /session-start\.mjs/);
  });
  check('init registers the team-context MCP server', () => {
    const mcp = JSON.parse(fs.readFileSync(path.join(tmp, '.mcp.json'), 'utf8'));
    assert.equal(mcp.mcpServers['team-context'].command, 'node');
  });
  check('init adds runtime files to .gitignore', () => {
    const gi = fs.readFileSync(path.join(tmp, '.gitignore'), 'utf8');
    assert.match(gi, /\.distill\.log/);
    assert.match(gi, /\.distill\.lock/);
  });
}

// ---- 2. init is idempotent ----
{
  run([ccc, 'init']);
  check('re-init does not duplicate hooks or MCP entries', () => {
    const settings = JSON.parse(fs.readFileSync(path.join(tmp, '.claude', 'settings.json'), 'utf8'));
    assert.equal(settings.hooks.SessionStart.length, 1);
    assert.equal(settings.hooks.SessionEnd.length, 1);
    assert.equal(settings.hooks.PostToolUse.length, 1);
    const mcp = JSON.parse(fs.readFileSync(path.join(tmp, '.mcp.json'), 'utf8'));
    assert.equal(Object.keys(mcp.mcpServers).length, 1);
  });
}

// ---- 3. session-start stays silent with an empty index ----
{
  const r = run([path.join(team, 'hooks', 'session-start.mjs')], { input: JSON.stringify({ cwd: tmp }) });
  check('session-start emits nothing before first distill', () => {
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });
}

// ---- 4. distill (mock) writes entries and regenerates the index ----
{
  const r = run([ccc, 'distill', '--transcript', fixture, '--mock']);
  check('mock distill exits 0', () => assert.equal(r.status, 0, r.stderr));
  check('distill writes a decision file', () => {
    const files = fs.readdirSync(path.join(team, 'decisions')).filter((f) => f.endsWith('.md'));
    assert.equal(files.length, 1);
    const body = fs.readFileSync(path.join(team, 'decisions', files[0]), 'utf8');
    assert.match(body, /title: Mock decision/);
    assert.match(body, /\*\*Why:\*\* testing/);
  });
  check('distill writes a knowledge file', () => {
    const body = fs.readFileSync(path.join(team, 'knowledge', 'mock-knowledge.md'), 'utf8');
    assert.match(body, /Node 18\+/);
  });
  check('distill appends to the author journal', () => {
    const files = fs.readdirSync(path.join(team, 'journal')).filter((f) => f.endsWith('.md'));
    assert.equal(files.length, 1);
    assert.match(fs.readFileSync(path.join(team, 'journal', files[0]), 'utf8'), /Mock distillation/);
  });
  check('distill regenerates INDEX.md', () => {
    const idx = fs.readFileSync(path.join(team, 'INDEX.md'), 'utf8');
    assert.match(idx, /Mock decision/);
    assert.match(idx, /Mock knowledge/);
  });
  check('distill releases its lock', () => {
    assert.ok(!fs.existsSync(path.join(team, '.distill.lock')));
  });
}

// ---- 5. session-start injects the populated index ----
{
  const r = run([path.join(team, 'hooks', 'session-start.mjs')], { input: JSON.stringify({ cwd: tmp }) });
  check('session-start emits additionalContext with team memory', () => {
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(ctx, /<team-memory>/);
    assert.match(ctx, /Mock decision/);
  });
}

// ---- 6. session-end skips short transcripts ----
{
  const small = path.join(tmp, 'small.jsonl');
  fs.writeFileSync(small, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
  const r = run([path.join(team, 'hooks', 'session-end.mjs')], {
    input: JSON.stringify({ cwd: tmp, transcript_path: small, session_id: 'short' }),
  });
  check('session-end exits 0 and skips tiny transcripts', () => {
    assert.equal(r.status, 0);
    assert.ok(!fs.existsSync(path.join(team, '.distill.log')), 'distiller should not have started');
  });
}

// ---- 7. session-end spawns a detached distill for real transcripts ----
{
  const r = run([path.join(team, 'hooks', 'session-end.mjs')], {
    input: JSON.stringify({ cwd: tmp, transcript_path: fixture, session_id: 'e2e-test' }),
    env: { ...process.env, CCC_MOCK_DISTILL: '1' },
  });
  check('session-end exits 0 immediately', () => assert.equal(r.status, 0, r.stderr));
  await (async () => {
    const log = path.join(team, '.distill.log');
    for (let i = 0; i < 40; i++) {
      if (fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('distilled session e2e-test')) break;
      await sleep(250);
    }
    check('detached distill completes and logs', () => {
      assert.ok(fs.existsSync(log), '.distill.log missing');
      assert.match(fs.readFileSync(log, 'utf8'), /distilled session e2e-test/);
    });
  })();
}

// ---- 8. redaction scrubs secrets from distilled output ----
{
  const distill = path.join(team, 'hooks', 'distill.mjs');
  // Feed the mock result through --dry-run with a doctored env: mock output is fixed,
  // so instead test redact via a decision written from a transcript that the model
  // would have echoed a secret from. We simulate by calling distill with mock and
  // checking the fixture's secret never appears anywhere in team memory.
  const all = [];
  for (const dir of ['decisions', 'knowledge', 'journal']) {
    for (const f of fs.readdirSync(path.join(team, dir))) {
      if (f.endsWith('.md')) all.push(fs.readFileSync(path.join(team, dir, f), 'utf8'));
    }
  }
  all.push(fs.readFileSync(path.join(team, 'INDEX.md'), 'utf8'));
  check('no fixture secret leaked into team memory', () => {
    assert.ok(!all.join('\n').includes('sk-ant-test12345678901234567890'));
  });
  check('redaction patterns scrub known secret shapes', () => {
    // distill.mjs must apply redaction; the patterns themselves live in common.mjs.
    assert.match(fs.readFileSync(distill, 'utf8'), /redactDeep\(result\)/);
    const script = [
      `import { redact } from ${JSON.stringify(pathToFileURL(path.join(team, 'hooks', 'common.mjs')).href)};`,
      `console.log(redact('key sk-ant-abc1234567890123456 tok ghp_abcdefghijklmnopqrstu456 aws AKIAABCDEFGHIJKLMNOP url https://user:hunter2secret@host/x password = supersecret99'));`,
    ].join('\n');
    const r = run(['--input-type=module', '-e', script]);
    assert.equal(r.status, 0, r.stderr);
    for (const leaked of ['sk-ant-abc', 'ghp_abcdef', 'AKIAABCDEFGHIJKLMNOP', 'hunter2secret', 'supersecret99']) {
      assert.ok(!r.stdout.includes(leaked), `leaked: ${leaked}`);
    }
    assert.match(r.stdout, /\[REDACTED KEY\]/);
    assert.match(r.stdout, /\[REDACTED TOKEN\]/);
    assert.match(r.stdout, /\[REDACTED AWS KEY\]/);
    assert.match(r.stdout, /:\[REDACTED\]@/);
  });
}

// ---- 9. status reports counts ----
{
  const r = run([ccc, 'status']);
  check('status reports entries and hooks', () => {
    assert.equal(r.status, 0);
    // Step 7 re-distilled the same session: its duplicate decision must be
    // skipped (title-slug dedup), leaving only step 4's original.
    assert.match(r.stdout, /decisions: 1/);
    assert.match(r.stdout, /SessionStart ok/);
    assert.match(r.stdout, /SessionEnd ok/);
  });
  check('re-distilling never duplicates a decision', () => {
    const files = fs.readdirSync(path.join(team, 'decisions')).filter((f) => f.endsWith('.md'));
    assert.equal(files.length, 1, `expected 1 decision file, got: ${files.join(', ')}`);
  });
}

// ================= Phase 2: presence & coordination =================
// The server must run OUT of process: spawnSync blocks this process's event
// loop while each hook child runs, so an in-process server could never answer
// them (their timeouts would trip the circuit breaker and cascade).
const TOKEN = 'test-secret';
const srv = spawn(process.execPath, [path.join(pkgRoot, 'server', 'sync-server.mjs'), '--port', '0', '--token', TOKEN], {
  stdio: ['ignore', 'pipe', 'pipe'],
});
const port = await new Promise((resolve, reject) => {
  const to = setTimeout(() => reject(new Error('sync server did not start within 10s')), 10000);
  let buf = '';
  srv.stdout.on('data', (d) => {
    buf += d;
    const m = buf.match(/listening on :(\d+)/);
    if (m) {
      clearTimeout(to);
      resolve(Number(m[1]));
    }
  });
  srv.on('exit', () => reject(new Error('sync server exited early')));
});
const base = `http://127.0.0.1:${port}`;
const repo = path.basename(tmp);
const authed = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

// ---- 10. server auth + event handling ----
{
  const noAuth = await fetch(`${base}/events`, { method: 'POST', body: '{}' });
  check('server rejects requests without token', () => assert.equal(noAuth.status, 401));

  const page = await fetch(`${base}/`);
  const html = await page.text();
  check('dashboard page is served without auth (data calls stay authed)', () => {
    assert.equal(page.status, 200);
    assert.match(html, /<title>ccc team dashboard<\/title>/);
  });

  const r = await fetch(`${base}/events`, {
    method: 'POST',
    headers: authed,
    body: JSON.stringify({ type: 'session_start', sessionId: 'alice-s1', user: 'alice', repo }),
  });
  check('server accepts session_start', async () => assert.equal(r.status, 200));

  await fetch(`${base}/events`, {
    method: 'POST',
    headers: authed,
    body: JSON.stringify({ type: 'file_touch', sessionId: 'alice-s1', user: 'alice', repo, path: 'src/app.ts' }),
  });
  await fetch(`${base}/events`, {
    method: 'POST',
    headers: authed,
    body: JSON.stringify({ type: 'task', sessionId: 'alice-s1', user: 'alice', repo, task: 'refactoring auth' }),
  });
  const act = await (await fetch(`${base}/activity?repo=${encodeURIComponent(repo)}`, { headers: authed })).json();
  check('activity lists alice with task and recent file', () => {
    assert.equal(act.sessions.length, 1);
    assert.equal(act.sessions[0].user, 'alice');
    assert.equal(act.sessions[0].task, 'refactoring auth');
    assert.equal(act.sessions[0].recentFiles[0].path, 'src/app.ts');
  });

  const fa = await (
    await fetch(`${base}/file-activity?path=${encodeURIComponent('src/app.ts')}&repo=${encodeURIComponent(repo)}`, { headers: authed })
  ).json();
  check('file-activity reports alice on src/app.ts', () => {
    assert.equal(fa.activity.length, 1);
    assert.equal(fa.activity[0].user, 'alice');
  });
}

// ---- 11. enable presence in the test project ----
{
  const cfgPath = path.join(team, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.presence = { url: base, token: TOKEN, user: 'bob' };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}

// ---- 12. post-tool hook warns on collision, stays silent otherwise ----
{
  const hook = path.join(team, 'hooks', 'post-tool.mjs');
  const collide = run([hook], {
    input: JSON.stringify({
      session_id: 'bob-s1',
      cwd: tmp,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmp, 'src', 'app.ts') },
    }),
  });
  check('post-tool warns when a teammate is in the same file', () => {
    assert.equal(collide.status, 0, collide.stderr);
    const out = JSON.parse(collide.stdout);
    const ctx = out.hookSpecificOutput.additionalContext;
    assert.match(ctx, /src\/app\.ts/);
    assert.match(ctx, /alice/);
  });

  const clean = run([hook], {
    input: JSON.stringify({
      session_id: 'bob-s1',
      cwd: tmp,
      tool_name: 'Write',
      tool_input: { file_path: path.join(tmp, 'src', 'other.ts') },
    }),
  });
  check('post-tool stays silent when no one else touched the file', () => {
    assert.equal(clean.status, 0, clean.stderr);
    assert.equal(clean.stdout.trim(), '');
  });
}

// ---- 13. session-start injects live presence alongside team memory ----
{
  const r = run([path.join(team, 'hooks', 'session-start.mjs')], {
    input: JSON.stringify({ cwd: tmp, session_id: 'bob-s2' }),
  });
  check('session-start injects team memory + presence blocks', () => {
    assert.equal(r.status, 0, r.stderr);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /<team-memory>/);
    assert.match(ctx, /<team-presence>/);
    assert.match(ctx, /alice/);
    assert.match(ctx, /refactoring auth/);
  });
}

// ---- 14. session-end marks the session ended on the server ----
{
  const small = path.join(tmp, 'small.jsonl');
  run([path.join(team, 'hooks', 'session-end.mjs')], {
    input: JSON.stringify({ cwd: tmp, transcript_path: small, session_id: 'alice-s1' }),
  });
  const act = await (await fetch(`${base}/activity?repo=${encodeURIComponent(repo)}`, { headers: authed })).json();
  check('session_end removes alice from active sessions', () => {
    assert.ok(!act.sessions.some((s) => s.user === 'alice'));
  });
}

// ---- 15. MCP server: initialize, tools/list, tools/call ----
{
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_team_memory', arguments: { query: 'Mock decision' } } },
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'check_file_activity', arguments: { path: 'src/app.ts' } } },
  ];
  const r = run([path.join(team, 'hooks', 'mcp-server.mjs')], {
    input: lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    timeout: 15000,
  });
  const replies = new Map(
    r.stdout
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .map((m) => [m.id, m]),
  );
  check('mcp initialize returns server info', () => {
    assert.equal(replies.get(1).result.serverInfo.name, 'ccc-team-context');
  });
  check('mcp tools/list exposes 4 tools', () => {
    assert.equal(replies.get(2).result.tools.length, 4);
  });
  check('mcp search_team_memory finds distilled entries', () => {
    assert.match(replies.get(3).result.content[0].text, /Mock decision/);
  });
  check('mcp check_file_activity reports alice touch', () => {
    assert.match(replies.get(4).result.content[0].text, /alice/);
  });
}

// ---- 16. handoff: create → upload → stage from server → consume once ----
{
  const hs = path.join(team, 'hooks', 'handoff.mjs');
  const created = run([hs, 'create', '--transcript', fixture, '--mock', '--cwd', tmp, '--session', 'alice-s1']);
  let id = '';
  check('handoff create exits 0 and prints an id', () => {
    assert.equal(created.status, 0, created.stderr);
    const m = created.stdout.match(/hf-[a-z0-9]+-[a-z0-9]+/);
    assert.ok(m, `no id in output: ${created.stdout}`);
    id = m[0];
    assert.match(created.stdout, /uploaded to sync server/);
  });

  const localFile = path.join(team, 'handoffs', `${id}.json`);
  check('handoff bundle written locally with todos from transcript', () => {
    const b = JSON.parse(fs.readFileSync(localFile, 'utf8'));
    assert.equal(b.title, 'Mock handoff');
    assert.equal(b.todos.length, 2);
    assert.equal(b.todos[1].status, 'in_progress');
  });

  const inbox = await (await fetch(`${base}/handoffs?repo=${encodeURIComponent(repo)}`, { headers: authed })).json();
  check('server inbox lists the handoff', () => {
    assert.ok(inbox.handoffs.some((h) => h.id === id));
  });

  // Stage from the SERVER — delete the local copy first to prove the fetch path.
  fs.rmSync(localFile);
  const staged = run([hs, 'stage', id, '--cwd', tmp]);
  check('resume stages the handoff fetched from the server', () => {
    assert.equal(staged.status, 0, staged.stderr);
    assert.ok(fs.existsSync(path.join(team, '.handoff-pending.json')));
  });

  const first = run([path.join(team, 'hooks', 'session-start.mjs')], {
    input: JSON.stringify({ cwd: tmp, session_id: 'carol-s1' }),
  });
  check('session-start injects the staged handoff', () => {
    assert.equal(first.status, 0, first.stderr);
    const ctx = JSON.parse(first.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /<handoff>/);
    assert.match(ctx, /Mock handoff/);
    assert.match(ctx, /Wire storage interface/);
  });
  check('handoff is consumed exactly once', () => {
    assert.ok(!fs.existsSync(path.join(team, '.handoff-pending.json')));
    const second = run([path.join(team, 'hooks', 'session-start.mjs')], {
      input: JSON.stringify({ cwd: tmp, session_id: 'carol-s2' }),
    });
    assert.ok(!second.stdout.includes('<handoff>'));
  });

  const listed = run([hs, 'list', '--cwd', tmp]);
  check('handoff inbox lists the bundle', () => {
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, new RegExp(id));
  });
}

// ---- 17. live sessions (ccc-live companion, mock agent) ----
{
  const liveSrv = spawn(
    process.execPath,
    [path.join(pkgRoot, 'live', 'live-server.mjs'), '--mock', '--port', '0', '--token', 'livetok'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const lport = await new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error('live server did not start within 10s')), 10000);
    let buf = '';
    liveSrv.stdout.on('data', (d) => {
      buf += d;
      const m = buf.match(/listening on :(\d+)/);
      if (m) {
        clearTimeout(to);
        resolve(Number(m[1]));
      }
    });
    liveSrv.on('exit', () => reject(new Error('live server exited early')));
  });
  const lbase = `http://127.0.0.1:${lport}`;
  const lauth = { authorization: 'Bearer livetok', 'content-type': 'application/json' };
  const waitFor = async (fn, ms = 3000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await fn()) return true;
      await new Promise((r) => setTimeout(r, 60));
    }
    return false;
  };

  const noAuth = await fetch(`${lbase}/rooms`);
  check('live server rejects requests without token', () => assert.equal(noAuth.status, 401));

  const ui = await fetch(`${lbase}/`);
  const uiHtml = await ui.text();
  check('live UI page is served', () => {
    assert.equal(ui.status, 200);
    assert.match(uiHtml, /<title>ccc live sessions<\/title>/);
  });

  const created = await (
    await fetch(`${lbase}/rooms`, { method: 'POST', headers: lauth, body: JSON.stringify({ title: 'pair debugging' }) })
  ).json();
  check('room created with an id', () => assert.match(created.id, /^rm-/));
  const rid = created.id;

  await fetch(`${lbase}/rooms/${rid}/messages`, {
    method: 'POST',
    headers: lauth,
    body: JSON.stringify({ from: 'alice', text: 'fix the auth bug' }),
  });
  await fetch(`${lbase}/rooms/${rid}/messages`, {
    method: 'POST',
    headers: lauth,
    body: JSON.stringify({ from: 'bob', text: 'and add a test for it' }),
  });
  const bothAnswered = await waitFor(async () => {
    const info = await (await fetch(`${lbase}/rooms/${rid}`, { headers: lauth })).json();
    const texts = info.events.filter((e) => e.type === 'assistant').map((e) => e.text);
    return texts.some((t) => t.includes('alice')) && texts.some((t) => t.includes('bob'));
  });
  check('two humans steer one agent: both messages answered in one room', () => assert.ok(bothAnswered));

  const stream = await fetch(`${lbase}/rooms/${rid}/stream?token=livetok`);
  const reader = stream.body.getReader();
  const chunk = new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  check('SSE stream replays the transcript buffer', () => {
    assert.equal(stream.status, 200);
    assert.match(chunk, /retry: 3000/);
    assert.match(chunk, /fix the auth bug/);
  });

  await fetch(`${lbase}/rooms/${rid}/end`, { method: 'POST', headers: lauth });
  const afterEnd = await fetch(`${lbase}/rooms/${rid}/messages`, {
    method: 'POST',
    headers: lauth,
    body: JSON.stringify({ from: 'carol', text: 'too late' }),
  });
  check('ended room refuses new messages', () => assert.equal(afterEnd.status, 409));

  liveSrv.kill();
}

// ---- 18. circuit breaker: unreachable server never breaks a session ----
{
  const cfgPath = path.join(team, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.presence.url = 'http://127.0.0.1:1'; // nothing listens here
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const r = run([path.join(team, 'hooks', 'post-tool.mjs')], {
    input: JSON.stringify({
      session_id: 'bob-s1',
      cwd: tmp,
      tool_name: 'Edit',
      tool_input: { file_path: path.join(tmp, 'src', 'app.ts') },
    }),
  });
  check('post-tool exits 0 with unreachable server and trips breaker', () => {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), '');
    assert.ok(fs.existsSync(path.join(team, '.presence-down')), 'breaker file missing');
  });
}

srv.kill();

// ---- cleanup ----
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {}

if (failures) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll tests passed.');
