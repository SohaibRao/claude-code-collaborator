---
title: Distiller and handoff call claude headlessly on user's existing auth
date: 2026-08-13
author: dell
session: manual
status: accepted
paths: ["templates/distill.mjs","templates/handoff.mjs"]
---

**What:** Session-end hook spawns `claude -p` (headless eval) to summarize work state; no separate API credentials or service account. Uses haiku by default (cheapest Claude model) for cost control.

**Why:** Leverages the user's existing Claude Code auth (no new secrets to manage); works offline if the user has cached auth; haiku is fast enough for summarization and keeps per-session cost negligible.

**Rejected alternatives:** Ship a Claude API key with ccc (too many secrets, keys are per-user not per-tool); require users to authenticate again (friction)
