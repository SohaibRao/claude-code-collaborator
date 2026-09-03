
## 2026-08-24 · session c9d8e705

Designed and built Claude Code Collaborator, a zero-dependency git-native tool that brings shared team memory, live presence, session handoff, and multiplayer editing to Claude Code. All four phases shipped, tested (48/48 passing), and dogfooding on this repo—users now onboard with `ccc init` and automatically contribute/consume distilled knowledge.

- decisions/2026-08-24-git-native-first-architecture-for-phases-1-3.md
- decisions/2026-08-24-zero-npm-dependencies-vendored-hook-scripts.md
- decisions/2026-08-24-distiller-uses-headless-claude-calls-on-user-s-existing-auth.md
- decisions/2026-08-24-presence-and-collision-warnings-are-advisory-never-blocking.md
- decisions/2026-08-24-home-directory-walk-up-halting-to-prevent-claude-folder-coll.md
- knowledge/distiller-uses-a-lock-file-to-prevent-concurrent-runs.md
- knowledge/secret-redaction-must-happen-before-storage-not-just-before-.md
- knowledge/handoff-bundle-consumption-is-exactly-once-per-session.md
- knowledge/process-deadlock-in-test-harness-when-sync-server-runs-in-pr.md
- knowledge/session-identity-mutation-bug-server-allows-renaming-a-sessi.md
