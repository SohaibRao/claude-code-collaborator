---
title: Git-native-first architecture for Phases 1–3
date: 2026-08-24
author: Realux Team
session: c9d8e705-2769-4c39-8717-ca50957a5955
status: accepted
paths: [".claude/team/","bin/ccc.mjs","templates/distill.mjs","templates/session-start.mjs"]
---

**What:** Team memory lives in `.claude/team/` committed to the repo; handoff bundles stored both in git and optionally on the sync server. No runtime database required for core features.

**Why:** Aligns collaboration with code review workflow; knowledge ships in the same PR as the code it explains; teammates onboard with `git clone` alone, no separate service. Keeps early phases deployable on any infrastructure.

**Rejected alternatives:** Cloud-only database would require account provisioning and introduce a runtime dependency; would break the zero-dependency goal and make the tool harder to adopt in isolated or air-gapped environments.
