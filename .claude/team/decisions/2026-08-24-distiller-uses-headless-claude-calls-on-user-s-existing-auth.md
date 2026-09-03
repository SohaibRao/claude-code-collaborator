---
title: Distiller uses headless Claude calls on user's existing auth
date: 2026-08-24
author: Realux Team
session: c9d8e705-2769-4c39-8717-ca50957a5955
status: accepted
paths: ["templates/distill.mjs","templates/handoff.mjs","templates/common.mjs"]
---

**What:** Session-end hook spawns `claude -p` (headless eval) to summarize work state; no separate API credentials or service account. Uses haiku by default (cheapest Claude model) for cost control.

**Why:** Users already trust their Claude login; reusing it eliminates account provisioning friction, token management, and permission questions. Headless mode is built into Claude Code, so the tool works immediately after `ccc init`.

**Rejected alternatives:** Service account or API key would require teams to provision and rotate credentials; OAuth/OIDC would add server complexity; offline summarization with local heuristics would miss context and produce shallow summaries.
