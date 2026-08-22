# Claude Code Collaborator (`ccc`)

**Git shares the code. `ccc` shares the context that produced it.**

Claude Code is single-player: everything your Claude learns during a session — decisions made, gotchas discovered, conventions settled — lives in local transcripts and per-user memory on one machine. Your teammate's Claude starts from zero and may contradict decisions yours already made.

`ccc` is a git-native team memory, **live presence**, and **session handoff** layer for Claude Code:

- **Team memory** — when a session ends, a distiller extracts the durable knowledge into `.claude/team/`, where it is reviewed and committed like any other change. When any teammate starts a session, that shared memory is injected automatically. Knowledge ships in the same PR as the code it explains.
- **Presence** (optional, needs one small server) — every teammate's session announces itself and the files it touches. Sessions see who else is working, agents get an advisory warning the moment they edit a file another developer's agent is already in, and MCP tools let agents query team activity on demand.
- **Handoff** — package an in-flight task (state summary, next steps, todo list, working diff) into a bundle a teammate resumes with full context, across desks, timezones, or shifts.
- **Live sessions** ([ccc-live](live/README.md) companion package) — one server-hosted agent, multiple humans watching the same transcript and steering it together in the browser.

## Quickstart

```bash
cd your-project
npx claude-code-collaborator init   # or: node bin/ccc.mjs init from a clone
git add .claude .gitignore && git commit -m "Add team memory"
```

That's it. Teammates get everything on `git pull` — no install needed, the hook scripts are vendored into the repo and need only Node 18+.

## How it works

**Write path.** A `SessionEnd` hook launches a detached distiller so shutdown is never blocked. The distiller reads the session transcript, calls Claude headlessly (`claude -p`, using your existing Claude Code auth — no separate API key), and extracts only durable knowledge:

- **Decisions** → `.claude/team/decisions/` — immutable records: what, why, rejected alternatives
- **Knowledge** → `.claude/team/knowledge/` — living documents: gotchas, constraints, conventions
- **Journal** → `.claude/team/journal/<author>.md` — append-only per-developer session digests (merge-conflict-free by construction)

You review the diff (`git diff .claude/team`) and commit it with your code.

**Read path.** A `SessionStart` hook injects the distilled `INDEX.md` into every session in the project — yours and every teammate's. Agents are instructed to respect recorded decisions and to flag conflicts instead of silently overriding them.

**Nothing raw is shared.** Transcripts stay on your machine. Only distilled summaries travel, a redaction pass scrubs secret-shaped strings (API keys, tokens, JWTs, private keys, credentialed URLs) as defense in depth, and everything passes human review before it is committed.

## Live presence (optional)

Run the sync server somewhere every developer can reach (LAN, VPN, small VM):

```bash
ccc serve --port 7377 --token your-shared-secret
# or: docker build -t ccc-sync . && docker run -p 7377:7377 -e CCC_SYNC_TOKEN=... ccc-sync
```

Then point the repo at it in `.claude/team/config.json`:

```json
"presence": { "url": "http://your-server:7377", "token": "your-shared-secret" }
```

What the team gets:

- **Web dashboard** — open the server URL in a browser: live sessions (who, what task, which files) and the handoff inbox, refreshing every 5 seconds. The page is static; its data calls carry the token you enter.
- **Session start** — a `<team-presence>` block: who is active, their current task, their recent files.
- **Edit-collision warnings** — a `PostToolUse` hook publishes each file touch and, in the same round trip, learns whether another developer's session touched that file in the last 30 minutes. If so, the agent receives an advisory heads-up. Warn, don't block.
- **MCP tools** (`team-context` server, registered by `ccc init`): `search_team_memory` (works even without presence), `get_team_activity`, `check_file_activity`.

Presence is engineered to be harmless when absent: no `presence.url` means the hooks exit instantly, and an unreachable server trips a 60-second circuit breaker after one 1.2s timeout — sessions never hang on it.

## Session handoff

```bash
# Departing developer — packages the latest session on this project:
ccc handoff            # → "handoff hf-xxxxx created — teammate picks it up with: ccc resume hf-xxxxx"

# Successor:
ccc inbox              # list handoffs for this project
ccc resume hf-xxxxx    # stage it — then just start Claude Code in the project
```

`ccc handoff` asks Claude (headlessly, on your auth) to summarize the session's state — done vs. in-progress vs. not-started, concrete next steps, in-flight warnings — and packages that with the last todo list from the transcript, the working `git diff`, and the final transcript excerpt. Redaction runs over the whole bundle.

Bundles travel two ways: committed in `.claude/team/handoffs/` (git-native, zero infrastructure) and/or uploaded to the sync server when presence is configured. `ccc resume` stages the bundle; the **next Claude Code session in the project receives it as first-class context exactly once** — the agent is instructed to verify repo state against the summary, adopt the predecessor's todo list, and continue rather than restart.

## Commands

| Command | What it does |
|---|---|
| `ccc init` | Set up `.claude/team/`, vendor hook scripts, register hooks in `.claude/settings.json` (idempotent) |
| `ccc status` | Show entry counts and hook registration |
| `ccc distill` | Manually distill the latest session transcript (`--transcript <path>`, `--dry-run`, `--mock`) |
| `ccc reindex` | Regenerate `INDEX.md` from entry files (e.g. after a merge) |
| `ccc handoff` | Package the latest session into a handoff bundle (`--title`, `--transcript`, `--no-upload`) |
| `ccc resume <id>` | Stage a handoff for the next session in this project (`--print` to just view it) |
| `ccc inbox` | List handoffs available for this project (git + server) |
| `ccc serve` | Run the team sync server (`--port`, `--token`, `--state`) |
| `ccc live` | Run the shared live-session server (`--port`, `--token`, `--model`, `--mock`) |

## Configuration — `.claude/team/config.json`

| Key | Default | Meaning |
|---|---|---|
| `model` | `"haiku"` | Model for distillation (small model keeps it cheap) |
| `claudeBin` | `""` | Path to the claude CLI; empty = auto-detect (PATH, then common install locations). `CCC_CLAUDE_BIN` env var overrides. |
| `maxIndexChars` | `8000` | Cap on injected index size |
| `maxTranscriptChars` | `120000` | Transcript budget sent to the distiller (head + tail kept) |
| `minTranscriptBytes` | `2000` | Sessions smaller than this are skipped |
| `distillTimeoutMs` | `300000` | Distiller timeout |
| `redact` | `true` | Secret-pattern redaction of distilled output |
| `presence.url` | `""` | Sync server URL; empty disables presence entirely. `CCC_SYNC_URL` env var overrides. |
| `presence.token` | `""` | Shared secret for the sync server (`CCC_SYNC_TOKEN` overrides) |
| `presence.user` | `""` | Display name; defaults to `git config user.name`, then OS username |

## Requirements

- Node 18+ (for the hooks; teammates need nothing else)
- [Claude Code](https://code.claude.com) (any auth — subscription or API key)
- git, for the memory to actually reach your team

## Development

```bash
npm test   # zero-dependency smoke suite; uses --mock, makes no Claude calls
```

## Status & roadmap

**All four designed phases are implemented**: shared team memory, presence & coordination, session handoff, the team dashboard, and shared live sessions (as the [ccc-live](live/README.md) companion package, keeping the core zero-dependency). See [DESIGN.md](DESIGN.md) for the full architecture and the research on why nothing built into Claude Code covers this today.

## License

MIT
