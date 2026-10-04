# Codex queue handoff

## Completed Factorio board work

- Task priorities, compact controls, responsive layout and automatic browser names are live. Bots have discretionary priority guidance in AGENTS.md. Latest implementation: `0ee0d7d`; browser/module checks and deployed cross-dashboard tests passed.
- Protected cleanup archives terminal tasks without breaking dependencies. Historical snapshots are outside the repo; later explicit resets are separate operations.

## Documentation cleanup: factorio-docs-only

Owner requested concise Factorio-only documentation with no code edits. Audited tracked Markdown, consolidated plans/history, retained runtime/worker/recovery/acceptance commands and removed superseded application material. Working in an isolated current-main worktree to preserve concurrent root changes.

Validation passed: all 30 remaining documentation files have no removed-topic references or broken local Markdown links; the diff against integrated main contains only Markdown changes. Documentation shrank from roughly 77,000 to 6,500 words. Concurrent source changes and the active inference handoff were preserved. No runtime tests were needed for this documentation-only edit. The development task records the pushed commit. Next work: follow the Factorio roadmap and live board; real-provider demo evidence remains outstanding.


## Current: factorio-stack-review

Reviewing main at `a9a9c9a` in an isolated worktree. Scope: Factorio runtime/bridge, inference workers, shared database/client, dashboards, deployment/recovery and acceptance coverage. No implementation edits. Completed review: 15 prioritized findings in [the report](../factorio-stack-review.md). Reproduced cross-language hash divergence, rejection quarantine, movement during pause and SIGKILL receipt rollback with unchanged history. Passed 36 Factorio units, 16 inference checks, board integration, root/dashboard/module typechecks and real-engine production/graceful restart. No provider calls or implementation fixes. Next: encoding/rejections, recovery/supervision, leases and inference-specific acceptance before live release. Pushed review commit is recorded on task `factorio-stack-review`.


Review follow-up: All 15 findings are tracked on Development with evidence, acceptance requirements and **push when finished**. Fourteen new Factorio tasks remain open (6 High, 6 Normal, 2 Low); identity authorization is consolidated into concurrently added High task `board-auth-tailnet`, and our duplicate is cancelled. `factorio-history-scale` covers Lua receipt scanning; `board-history-scale` covers shared subscriptions/rendering. Existing assignments were preserved; freeplay capability work depends on `factorio-ci-fault-acceptance`. Start with `factorio-wire-canonicalization` and `factorio-rejection-receipts`, then recovery/supervision, lease renewal and the inference verifier.


## Current: factorio-rejection-receipts

Implemented durable terminal failure receipts for valid scoped rejected operations; malformed envelopes/foreign histories still fail admission, and rejecting a second request preserves the actor’s current busy operation. Worker tests prove next-turn feedback and restart without replay. Passed 18 inference tests, root typecheck, real-engine rejection/replay/restart/conservation checks and the existing production/graceful-restart fixture. `factorio/check-rejections.py` is documented in the runtime guide. Canonicalization owner’s files were preserved; board result records the pushed commit.


## Current: factorio-inference-lease-renewal

Implemented independent 15-second resource renewal during model calls/pause, serialized refreshes, five-second renewal timeout, and cancellation on lost/expired/uncertain leases without reacquiring peer resources. Expired peer reservations are omitted from model context and do not prevent atomic acquisition. Rules/inference workers share the entity namespace; old-version workers must be stopped before mixing versions. Passed all 46 Factorio unit tests, root typecheck and bundled worker build; the board result records the pushed commit. Next independent work: crash/save recovery, inference supervision and current-path verification.
