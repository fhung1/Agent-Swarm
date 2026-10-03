# Factorio demo tooling handoff

## factor-plan — runtime and preflight

- Status: installer/preflight and tested RCON patch complete; production integration remains pending under board task `factorio-f0-runtime`.
- Scope: isolated `factorio-demo/` tools on `feat/factorio-demo`; core implementation owned by codex-factorio, independent engine/viewer checks by codex-board-worker.
- Implemented: pinned Linux x64 headless installer, executable configuration/version/mod/port/board preflight, port-conflict/config tests, and production-runtime start/save/restart/mismatch probe.
- Checks: installer downloaded official 2.0.77 and rerun preserved it; default-path preflight passed all checks against the implementation checkout; two preflight tests passed; shell syntax and JS syntax passed. Independent real-engine smoke passed ten actors, exactly-once mining, pause and save/restart.
- Finding/fix: existing production RCON sends a type-0 delimiter rejected by Factorio. Unmodified runtime probe times out. `patches/rcon-delimiter.patch` uses a type-2 echo command; in a disposable copy, the actual production runtime passes startup/save/restart and version/seed mismatch checks.
- Limits: no worker fleet or graphical client demonstration claimed. Preflight checks board TCP reachability, not database publication/authentication. GUI viewer work remains with independent acceptance owner.
- Shared HANDOFF.md is locked by the core owner; this distinct entry was requested for inclusion there.
- Next: core owner integrates tested RCON patch and setup tools, runs the production runtime probe, and records F0 acceptance. Then proceed to durable board worker and visible ten-agent demo.
