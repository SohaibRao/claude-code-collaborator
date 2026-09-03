---
title: Zero npm dependencies, vendored hook scripts
date: 2026-08-24
author: Realux Team
session: c9d8e705-2769-4c39-8717-ca50957a5955
status: accepted
paths: ["bin/ccc.mjs","templates/","live/"]
---

**What:** All Phase 1–3 logic (session-start.mjs, session-end.mjs, distill.mjs, post-tool.mjs, handoff.mjs, common.mjs) ships as plain ESM modules; `ccc` CLI is a single .mjs file. No `package.json` in the vendored tree. Agent SDK dependency isolated to separate `live/` package.

**Why:** Hook scripts run in the user's Claude Code harness and must install instantly; npm dependencies would add setup friction. Keeping the core dependency-free lowers friction for adoption and maintenance. Agent SDK separation preserves the core's lean profile while unblocking multiplayer experiments.

**Rejected alternatives:** Consolidated monorepo with shared package.json would couple concerns and force all teams to install SDK even if they never use live sessions. Inline dependencies in hooks would make them harder to maintain.
