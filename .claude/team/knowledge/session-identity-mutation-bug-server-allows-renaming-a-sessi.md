---
title: Session identity mutation bug: server allows renaming a session owner
date: 2026-08-13
author: dell
paths: ["server/sync-server.mjs"]
---

The sync server's presence endpoint initially allowed any incoming `/presence` call to overwrite the `owner` field of an existing session (identified by session_id). Fixed with first-write-wins: the owner is set on first touch and immutable thereafter. Prevents accidental session hijacking.
