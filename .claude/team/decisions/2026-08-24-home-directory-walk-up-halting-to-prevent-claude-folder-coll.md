---
title: Home directory walk-up halting to prevent .claude folder collision
date: 2026-08-24
author: Realux Team
session: c9d8e705-2769-4c39-8717-ca50957a5955
status: accepted
paths: ["templates/common.mjs","templates/session-start.mjs","templates/distill.mjs","templates/post-tool.mjs"]
---

**What:** Root-detection logic in common.mjs stops at the user's home directory; avoids matching global `~/.claude` as a project root when traversing up from a temp directory.

**Why:** Test runs and sandboxed operations start in temp directories outside the project tree and walk up looking for `.claude/team/`. Without a halt, they collide with the user's personal Claude Code folder and write to the wrong `.claude/settings.json`. This was discovered and fixed when tests briefly corrupted the machine's global settings.

**Rejected alternatives:** Checking only for `.git` would miss projects that don't use git; requiring an explicit root marker would add friction to adoption.
