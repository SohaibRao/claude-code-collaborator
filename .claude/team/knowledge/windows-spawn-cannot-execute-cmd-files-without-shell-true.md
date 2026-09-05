---
title: Windows spawn() cannot execute .cmd files without shell: true
date: 2026-09-05
author: SohaibRao
paths: ["templates/distill.mjs","templates/handoff.mjs"]
---

On Windows, Node's spawn() cannot directly execute .cmd files without shell: true following CVE-2024-27980; attempting spawn() without it throws EINVAL. Any subprocess spawning of .cmd files on Windows must use shell: true and pass user-controlled input via stdin instead of the argument list to maintain security.
