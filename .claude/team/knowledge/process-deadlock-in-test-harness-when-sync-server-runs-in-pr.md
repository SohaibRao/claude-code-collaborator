---
title: Process deadlock in test harness when sync server runs in-process
date: 2026-08-24
author: Realux Team
paths: ["test/run-tests.mjs","server/sync-server.mjs"]
---

Running the sync server in the same Node process as test spawning causes deadlock: `spawnSync` blocks until child exits, but the child is a hook trying to HTTP POST to the server, which is blocked on the main thread. Solution: run sync server in a separate subprocess for tests (use `spawn` to background it).
