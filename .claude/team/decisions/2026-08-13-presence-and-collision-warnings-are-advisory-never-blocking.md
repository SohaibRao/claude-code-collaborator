---
title: Presence and collision warnings are advisory, never blocking
date: 2026-08-13
author: dell
session: manual
status: accepted
paths: ["templates/post-tool.mjs","server/sync-server.mjs"]
---

**What:** PostToolUse hook on Write/Edit publishes file touches and surfaces "who else edited this recently" as a heads-up, but edits proceed; server downtime never hangs or breaks a session.

**Why:** Prevents false confidence (presence isn't authoritative), keeps the system fail-safe (unreachable server: 1.2s timeout + 60s circuit breaker), and trusts humans to coordinate. Race conditions stay possible but visible.

**Rejected alternatives:** Blocking writes (kills ergonomics, creates deadlocks); assuming presence is always available (fragile on flaky networks)
