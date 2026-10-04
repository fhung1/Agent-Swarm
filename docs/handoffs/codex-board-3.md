# codex-board-3 handoff

- Task: `pilot-preflight-scope` (push when finished).
- Status: complete; implementation pushed to `main` as `4766daf`.
- Change: paper pilot preflight now checks only paper configuration, required process secrets, paper worker builds and local SpacetimeDB. Removed Minecraft runtime/build/listener checks and stale Factorio deferral message.
- Checks: `tsc --noEmit`, esbuild bundle, `git diff --check`, and a runtime fixture with no Minecraft services all passed. The runtime fixture read the local SpacetimeDB ping endpoint; no broker or model calls were made.
- Next: mark the task done on the development board and release its file locks. Other board tasks remain available.

## board-auth-tailnet

- Status: implementation pushed as `d6307f8`; live development and gameplay modules published with data preserved.
- Finding: both board modules accept a self-declared session name for every mutation. A tailnet client with a different SpacetimeDB token can impersonate an existing participant.
- Plan: bind names to authenticated `ctx.sender`, protect cleanup with an operator identity, and provide an explicit operator path to bind existing sessions or recover a lost token. Test distinct-token rejection on both modules in disposable databases before pushing. Keep the live relay closed during migration/bootstrap.
- Implementation: both modules store a private name-to-identity binding; registration and every mutating reducer validate it. Cleanup and reassignment require the bootstrapped operator identity. CLI commands support bootstrap, binding legacy development names and explicit participant recovery. Existing board rows remain intact.
- Checks passed: `npm run check:message-board` with distinct-token impersonation and recovery cases, `python3 scripts/check-board-cleanup.py`, `npm run typecheck`, CLI esbuild, and `git diff --check`.
- Deployment: stopped the tailnet relay, published both modules with `--delete-data=never`, bootstrapped their operators using the local CLI identity, and bound all historical development names. The gameplay board had no historical sessions. Reopened the relay as exec session `32564`; `http://100.107.208.76:3001/v1/ping` returned HTTP 200. Local `codex-board-3` registration and board status work. Anonymous registration as `codex-board-3` through the relay was rejected with `Session codex-board-3 belongs to another identity`.
- Operational note: browser names with distinct historical tokens were included in the bulk development binding and need operator reassignment to their original identity, or a new name on reconnect. Preserve the operator CLI token; only it can reassign names or run cleanup.

## Factorio publication queue

- `factorio-inference-supervision-publication`: replayed source commit `f6e5991` as `3d752ef` on current main. Root typecheck, the supervisor and launcher bundles, and four supervisor tests passed; pushing directly to main.
