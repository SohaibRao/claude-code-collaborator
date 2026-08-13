
## 2026-08-13 · session manual

Built Claude Code Collaborator (ccc), a three-phase npm package that enables team collaboration on Claude Code sessions. Phase 1 (git-native shared memory via distiller hook) + Phase 2 (sync server with presence/collision warnings) + Phase 3 (session handoff bundle exchange) are complete, tested (41/41 passing), and committed; Phase 4 (dashboard and multiplayer sessions via Agent SDK) is pending.

- decisions/2026-08-13-git-native-first-architecture-for-phases-1-3.md
- decisions/2026-08-13-zero-npm-dependencies-vendored-hook-scripts.md
- decisions/2026-08-13-presence-and-collision-warnings-are-advisory-never-blocking.md
- decisions/2026-08-13-distiller-and-handoff-call-claude-headlessly-on-user-s-exist.md
- decisions/2026-08-13-home-directory-walk-up-halting-to-prevent-claude-folder-coll.md
- knowledge/session-identity-mutation-bug-server-allows-renaming-a-sessi.md
- knowledge/process-deadlock-in-test-harness-when-sync-server-runs-in-pr.md
- knowledge/secret-redaction-must-happen-before-storage-not-just-before-.md
- knowledge/handoff-bundle-consumption-is-exactly-once-per-session.md
- knowledge/distiller-uses-a-lock-file-to-prevent-concurrent-runs.md
