---
title: SQLite as default storage backend with pluggable interface
date: 2026-09-05
author: SohaibRao
session: a51b2aa7-78ee-41bb-92d0-fd9612ae80e9
status: accepted
paths: ["server/sync-server.mjs","Dockerfile"]
---

**What:** Use SQLite as the default persistent storage for the sync server, with a pluggable storage interface allowing Postgres as a drop-in option for larger deployments

**Why:** MVP is self-hosted with low write volume (few events/second peak), zero-config Docker setup is critical for evaluators, operational simplicity prioritized over raw throughput, and must avoid requiring a separate database container for the default deployment path

**Rejected alternatives:** Postgres—adds container orchestration overhead, migration complexity, and operational burden not justified for MVP phase despite better scalability for future large teams
