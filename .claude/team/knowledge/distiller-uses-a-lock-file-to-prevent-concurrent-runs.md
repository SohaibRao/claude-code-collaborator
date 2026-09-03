---
title: Distiller uses a lock file to prevent concurrent runs
date: 2026-08-24
author: Realux Team
paths: ["templates/session-end.mjs","templates/distill.mjs"]
---

SessionEnd hook spawns the distiller detached (never blocks shutdown). If two sessions in the same project end simultaneously, both would regenerate `.claude/team/INDEX.md`. Implemented as `.claude/team/.distill.lock` (gitignored): session-end skips launching a distill while a lock younger than 10 minutes exists; the distiller writes the lock with its pid on start and removes it in a `finally`. Stale locks (>10 min) are treated as dead and ignored.
