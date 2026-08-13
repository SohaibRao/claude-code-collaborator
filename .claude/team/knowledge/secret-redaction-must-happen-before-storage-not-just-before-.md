---
title: Secret redaction must happen before storage, not just before transmission
date: 2026-08-13
author: dell
paths: ["templates/common.mjs","templates/distill.mjs","templates/handoff.mjs"]
---

Distilled decisions and knowledge files are written to `.claude/team/` and committed to git; if they contain redacted content, it stays in history. Redaction layer (checking for AWS keys, bearer tokens, email patterns) must run on every transcript excerpt before any write. Test this with real secret-shaped strings, not just mocks.
