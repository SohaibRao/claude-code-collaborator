---
title: Home directory walk-up halting to prevent .claude folder collision
date: 2026-08-13
author: dell
session: manual
status: accepted
paths: ["templates/common.mjs"]
---

**What:** Root-detection logic in common.mjs stops at the user's home directory; avoids matching global `~/.claude` as a project root when traversing up from a temp directory.

**Why:** Discovered via bug: a test spawn'd from a temp dir, walked up, and matched `~/.claude` as a project, registering hooks in the user's global settings. Very dangerous — silently pollutes global config.

**Rejected alternatives:** Stop at .git (doesn't exist in every repo); stop at first .claude found (can be wrong if home/.claude exists)
