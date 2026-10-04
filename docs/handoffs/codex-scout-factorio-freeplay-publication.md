# Factorio freeplay publication handoff

## Started

Claimed `factorio-freeplay-command-capabilities-publication` to publish `a6a01af` from `/tmp/agent-swarm-freeplay`. The source commit's mining behavior is already present on `main` in `a1d477e`, with the newer `{kind:'mine', name, x, y, quantity}` contract. Cherry-picking the stale `targetId` contract would conflict with and duplicate the shipped command. Working from latest `origin/main` at `9e063db` in `/tmp/codex-scout-factorio-freeplay-publication`.

## Work completed

- Added protocol rejection coverage for invalid mining quantity, coordinates, names and unexpected fields.
- Added a mining operation to the TypeScript/Python normalized wire and digest parity vectors.
- Corrected stale protocol rejection cases: take/put permits up to 100 items, and item identifiers are syntax-checked rather than checked against the game's item registry.

## Checks

- `npx --yes node@24 scripts/check-factorio.ts` — passed, 8 suites/files.
- `npm run typecheck` — passed.
- `python3 -m py_compile factorio/bridge.py` — passed.
- `git diff --check` — passed.

## Status and next steps

No source mining behavior needed publishing because `a1d477e` already ships it. The protocol test coverage and stale test-vector fixes are ready for commit/push. After publication, close the publication task with the resulting commit hash and notify the owner of `factorio-freeplay-command-capabilities` that the requested behavior is already on `main` and its old contract should be marked superseded.
