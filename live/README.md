# ccc-live — shared live sessions

The Phase 4b companion package to [Claude Code Collaborator](../README.md): **one server-hosted Claude agent, multiple humans watching and steering it together** — a multiplayer session in the browser.

This lives outside the zero-dependency `ccc` core because it needs the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview) (`npm install` here pulls it in). The agent runs on the host machine's existing Claude Code auth.

```bash
cd live && npm install
ccc live --token your-secret          # from the repo root (or: node live/live-server.mjs)
# open http://localhost:7378 — create a room, share the URL + token with teammates
```

How it works:

- Each **room** hosts one agent session (Agent SDK streaming input, `permissionMode: acceptEdits`, cwd = the project).
- Every connected browser receives the same transcript over **SSE** — user messages, assistant text, tool activity, per-turn cost.
- Anyone can type; messages are attributed inline (`[alice] …`) so the agent knows who asked for what, and everyone sees everyone's steering.
- `--mock` runs a canned agent (no SDK, no API calls) — used by the test suite and handy for demos.

Advisory-first like the rest of ccc: rooms are transient (in-memory, capped transcript buffer), and the server never touches your repo except through the agent itself.
