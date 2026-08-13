# Claude Code Collaborator — Design Document

> Status: Draft v0.1 · 2026-08-12
> A team collaboration layer for Claude Code: shared context, live coordination, and session handoff.

## 1. The Problem

Claude Code is a single-player tool in a multiplayer world. On a team where several developers each run Claude Code against the same codebase:

1. **Knowledge silos.** Developer A spends hours with Claude establishing architecture decisions, discovering gotchas, and settling conventions. That context lives in A's local session transcripts and memory, on A's machine, under A's account. Developer B's Claude starts from zero — and may actively contradict decisions A's Claude already made.
2. **Collision without awareness.** Two developers' Claude sessions can simultaneously refactor overlapping code. Git catches the collision at merge time — hours after it could have been prevented at *intent* time ("someone's agent is already working on auth").
3. **No handoff.** An in-flight Claude task (plan approved, todos half-done, context loaded) cannot be handed to a teammate across a timezone or shift boundary. The successor re-explains everything from scratch.
4. **No visibility.** A team lead cannot see what plans and prompts teammates' agents are executing until the code lands in a PR — too late to redirect wasted effort.
5. **Inconsistent agent behavior.** Checked-in `CLAUDE.md` and `.claude/` solve *static* configuration sharing, but everything Claude *learns dynamically* (memory, decisions, discovered constraints) stays per-user, per-machine.

Git shares **code**. Nothing shares the **context that produced the code**.

## 2. What Exists Today (and why it isn't enough)

Validated against official Claude Code documentation, August 2026 (details in §8):

| Existing mechanism | What it shares | Why it doesn't close the gap |
|---|---|---|
| `CLAUDE.md`, `.claude/` (settings, rules, skills, agents, hooks, MCP config) via git | Static instructions & config | Hand-written; captures nothing the agent *learns* during sessions |
| Web session sharing (Team/Enterprise, claude.ai/code) | Read-only view + comments on a cloud session | Review-only, not live; a teammate cannot continue or build on that context |
| `--teleport` | Pulls your own cloud session into the terminal, history intact | One-way and single-user; no local→cloud push, no cross-user resume |
| Cross-session messaging (v2.1.224+) | Plain-text messages between *your own* sessions | Text only, one user; no history or context travels with the message |
| Agent Teams (experimental) | Multiple coordinated Claude instances with a shared task list | All instances belong to one developer inside one session |
| Auto-memory (`~/.claude/projects/<project>/memory/`) | Facts one user's Claude saved | Per-user, per-machine; invisible to every teammate's Claude |
| Session transcripts (`~/.claude/projects/<project>/*.jsonl`) | Nothing — machine-local | Internal format, subject to change, ~30-day cleanup, never shared |
| Git commits / PRs | Final code | Loses the reasoning, rejected alternatives, and constraints discovered |

The pattern is consistent: **configuration shares well; cognition doesn't.** Everything Claude learns, decides, and plans stays trapped in one developer's session on one machine — and nothing on the public roadmap addresses it.

## 3. Design Principles

1. **Git-native by default, real-time where it must be.** Async knowledge (memory, decisions) travels in the repo itself — zero infrastructure, works offline, merges like code. Only presence and handoff need a live channel.
2. **Build on official extension points only.** Hooks, MCP servers, and the Agent SDK. No forking Claude Code, no fragile internal APIs. One `npx ccc init` and the whole team is onboarded via the repo.
3. **Summaries travel, transcripts stay home.** Raw transcripts contain secrets and noise. Only distilled, reviewable knowledge is shared — privacy and token budgets both demand it.
4. **Warn, don't block.** Coordination signals are advisory (like git's model), not locks that stall developers.

## 4. Architecture — Three Layers

```
┌─────────────────────────────────────────────────────────┐
│  Layer 3: Session Handoff            (portable bundles) │
│  Layer 2: Presence & Coordination    (light sync server)│
│  Layer 1: Shared Team Memory         (git-native, no    │
│                                       infra required)   │
└─────────────────────────────────────────────────────────┘
     integrated via: Hooks + MCP server + ccc CLI
```

### Layer 1 — Shared Team Memory (git-native)

A `.claude/team/` directory in the repo, maintained automatically:

```
.claude/team/
  decisions/        # one file per decision: what, why, alternatives rejected
  knowledge/        # discovered constraints, gotchas, conventions
  journal/          # append-only per-dev session digests (merge-conflict-free)
  INDEX.md          # distilled index injected at session start
```

**Write path:** a `SessionEnd`/`Stop` hook runs a *distiller* (a headless Agent SDK call) over the session transcript. It extracts only durable knowledge — decisions made, gotchas found, conventions established — into structured markdown. Developer reviews the diff and commits it with their code. Knowledge ships in the same PR as the code it explains.

**Read path:** a `SessionStart` hook injects the distilled `INDEX.md` (plus relevance-matched entries) into every teammate's session. An MCP tool `search_team_memory` lets the agent pull deeper entries on demand instead of front-loading tokens. Path-scoped knowledge additionally lands as `.claude/rules/*.md` entries, which Claude Code natively loads only when matching files are edited — team knowledge about `src/auth/` surfaces exactly when a teammate's agent touches `src/auth/`.

**Merge story:** journals are append-only per-developer files (no conflicts); the index is regenerated deterministically. Memory merges as easily as code.

### Layer 2 — Presence & Coordination (real-time)

A lightweight sync server (self-hosted Docker container or hosted option) plus MCP tools:

- Hooks publish directly to the sync server using Claude Code's native **HTTP hook type** (POST JSON — no shell scripts to maintain): session lifecycle (`SessionStart`/`SessionEnd`), task intent (`TaskCreated`/`TaskCompleted`, plan submissions), and touched files (`PostToolUse` on Edit/Write, `FileChanged`).
- Teammates' agents consult `get_team_activity` / `check_file_activity` MCP tools — and a `PreToolUse` hook warns when the agent is about to edit files another agent is actively working in: *"Priya's session has been editing `src/auth/*` for 20 minutes — coordinate or pick different scope."*
- A web dashboard shows live team state: active sessions, current plans, files in flight, and recent decisions.

Advisory only. Nothing blocks; everything informs — the agent (and human) decides.

### Layer 3 — Session Handoff (portable context)

- `ccc handoff` packages the current session into a bundle: distilled context summary + plan + todo state + working diff + key transcript excerpts.
- A teammate runs `ccc resume <handoff-id>`: a fresh session starts with the bundle injected as first-class context, continuing the todos and plan rather than restarting them.
- **Later (Phase 4):** true shared live sessions — one server-hosted agent (Agent SDK) that multiple humans observe and steer, like a multiplayer claude.ai/code cloud session.

## 5. Components

| Component | Role | Tech |
|---|---|---|
| `ccc` CLI | `init`, `handoff`, `resume`, `status`; installs hooks + MCP config into `.claude/` (checked in — team onboards via `git pull`) | Node/TypeScript, npm package |
| Distiller | Transcript → durable knowledge extraction | Claude Agent SDK (headless), Haiku-class model for cost |
| `team-context` MCP server | `search_team_memory`, `log_decision`, `get_team_activity`, `check_file_activity`, `handoff_session` | TypeScript MCP SDK |
| Sync server | Presence, activity feed, handoff bundle storage | Small WebSocket + REST service; SQLite/Postgres; Docker image |
| Dashboard | Live team view, decision browser, handoff inbox | Web app on the sync server |

## 6. Roadmap

| Phase | Scope | Infra required | Status |
|---|---|---|---|
| **1 — Shared memory (MVP)** | `ccc init`, distiller hook, session-start injection, `.claude/team/` format | None (git only) | ✅ shipped v0.1.0 (2026-08-12) |
| **2 — Presence** | Sync server, activity MCP tools, edit-collision warnings | One small server | ✅ shipped v0.2.0 (2026-08-13) |
| **3 — Handoff** | Bundle format, `handoff`/`resume`, handoff inbox | Same server (or git-only) | ✅ shipped v0.3.0 (2026-08-13) |
| **4 — Dashboard & live sessions** | Web dashboard; shared server-hosted agent sessions | Same server + Agent SDK runtime | dashboard ✅ shipped v0.4.0 · live sessions planned |

Phase 1 alone already closes the biggest gap (knowledge silos) with zero infrastructure — the repo *is* the database.

## 7. Risks & Mitigations

- **Privacy / secrets in transcripts** → distiller shares summaries only, runs a secret-pattern redaction pass, and every shared entry goes through the normal PR review a code change would.
- **Context-window noise** → inject only the index; deep entries fetched on demand via MCP tool; per-entry TTL/decay and relevance scoring.
- **Anthropic ships native multiplayer** → building git-native + self-hostable + reviewable-in-PRs is a durable differentiator; and Phase 1's repo format would remain useful even alongside a native cloud offering.
- **Transcript format drift** → the docs explicitly mark the transcript JSONL format as internal and subject to change. Primary integration is therefore hooks (documented events with JSON payloads including `session_id` and `transcript_path`); transcript parsing is best-effort enrichment only.

## 8. Research Notes — Current Claude Code Capabilities (verified August 2026)

**Extension points this design builds on:**

- **Hooks — 33 documented event types**, including `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `TaskCreated`, `TaskCompleted`, `TeammateIdle`, `FileChanged`, and `PreCompact`. Four delivery types are relevant here: **command** (shell), **HTTP** (POST JSON — our presence transport), **MCP tool**, and **agent**. Every hook receives `session_id`, `transcript_path`, `cwd`, `permission_mode`, and event-specific data — exactly the inputs the distiller and presence publisher need. Hook definitions live in `.claude/settings.json`, so `ccc init` can check them into the repo and the whole team inherits them on `git pull`.
- **MCP servers** — configured via `.mcp.json` / `.claude/settings.json` (repo-shareable); organizations can enforce servers via `managed-mcp.json`.
- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk` / `claude-agent-sdk`) — a headless, self-hosted Claude Code harness with the full built-in tool set. Powers the distiller (Phase 1) and server-hosted shared live sessions (Phase 4).
- **Session transcripts** — `~/.claude/projects/<project>/<session-id>.jsonl`; internal format, ~30-day default retention (`cleanupPeriodDays`). Treated as enrichment only.
- **`.claude/rules/*.md`** — path-scoped rules that load only when matching files are edited; a native distribution channel for path-scoped team knowledge.
- **OpenTelemetry** — covers tool execution (useful for org-level dashboards), but there is no event bus or pub/sub; hooks are the only push mechanism, which is why the sync server exists.

**Adjacent features confirmed NOT to cover the gap:**

- No shared context, conversation, or memory between two developers — auto-memory and transcripts are per-user, per-machine.
- Web session sharing (Team/Enterprise) is read-only review with comments; a teammate cannot resume or extend the session.
- `--teleport` restores cloud→terminal for the same user only; there is no local→cloud push and no cross-user resume.
- Cross-session messaging (v2.1.224+, macOS/Linux) sends plain text between one user's own sessions — no history, files, or context travels.
- Agent Teams (experimental) coordinates one developer's parallel instances, not multiple humans.
- Nothing shipped or announced covers multiplayer sessions, team memory, activity feeds, or async handoff — the roadmap through August 2026 is silent on all of it.
