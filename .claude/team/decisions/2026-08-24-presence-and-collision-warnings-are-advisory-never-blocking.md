---
title: Presence and collision warnings are advisory, never blocking
date: 2026-08-24
author: Realux Team
session: c9d8e705-2769-4c39-8717-ca50957a5955
status: accepted
paths: ["templates/post-tool.mjs","server/sync-server.mjs"]
---

**What:** PostToolUse hook on Write/Edit publishes file touches and surfaces "who else edited this recently" as a heads-up, but edits proceed. Server downtime never hangs or breaks a session.

**Why:** Collaboration tools that block (waiting for locks, requiring server approval) paralyze development. Advisory keeps the UX frictionless while still surfacing conflicts so humans can coordinate. Fail-safe engineering ensures the sync server is optional infrastructure—any session works without it, and a down server costs one timeout, then trips a circuit breaker.

**Rejected alternatives:** Hard locking would require distributed consensus, dramatically complicate the system, and break the offline-first model. Ignoring conflicts entirely would recreate the original problem (silent overwrites).
