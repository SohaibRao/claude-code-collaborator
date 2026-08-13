---
title: Git-native-first architecture for Phases 1–3
date: 2026-08-13
author: dell
session: manual
status: accepted
paths: [".claude/team/","templates/distill.mjs","templates/handoff.mjs"]
---

**What:** Team memory lives in `.claude/team/` committed to the repo; handoff bundles stored both in git and optionally on the sync server. No runtime database required for core features.

**Why:** Minimizes friction to adoption (just `git pull`), makes decisions reviewable in PRs (knowledge ships with code), and ensures team state survives server downtime. Self-hosted becomes optional in Phase 4.

**Rejected alternatives:** Cloud-first (team would need to trust external host immediately); database-backed (adds DevOps burden; git is already the deployment/sync mechanism)
