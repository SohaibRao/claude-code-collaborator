---
title: Handoff bundle consumption is exactly-once per session
date: 2026-08-13
author: dell
paths: ["templates/session-start.mjs","server/sync-server.mjs"]
---

`ccc resume <id>` stages a rendered handoff context into `.claude/team/.handoff-pending.json` (gitignored). The SessionStart hook injects it into the next session in the project and deletes the staging file — consumed exactly once, so a handoff is never replayed across later session starts. The underlying bundle is NOT deleted: it stays in `.claude/team/handoffs/` (if committed) and on the sync server until its 14-day TTL, so it can be re-staged deliberately with another `ccc resume`.
