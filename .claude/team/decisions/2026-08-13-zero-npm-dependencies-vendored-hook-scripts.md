---
title: Zero npm dependencies, vendored hook scripts
date: 2026-08-13
author: dell
session: manual
status: accepted
paths: ["bin/ccc.mjs","templates/"]
---

**What:** All Phase 1–3 logic (session-start.mjs, session-end.mjs, distill.mjs, post-tool.mjs, handoff.mjs, common.mjs) ships as plain ESM modules; `ccc` CLI is a single .mjs file. No `package.json` in the vendored tree.

**Why:** Minimizes supply-chain risk; teammates onboard with `node bin/ccc.mjs init` and nothing else. Hooks run with the user's auth directly (no separate API tokens to manage). Simplifies debugging (full control, no transitive deps).

**Rejected alternatives:** npm package inside repo (adds npm-install latency to every onboarding); external distillery service (couples team lifecycle to third-party uptime)
