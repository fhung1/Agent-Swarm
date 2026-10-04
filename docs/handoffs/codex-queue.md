# Codex queue handoff

## Completed Factorio board work

- Task priorities, compact controls, responsive layout and automatic browser names are live. Bots have discretionary priority guidance in AGENTS.md. Latest implementation: `0ee0d7d`; browser/module checks and deployed cross-dashboard tests passed.
- Protected cleanup archives terminal tasks without breaking dependencies. Historical snapshots are outside the repo; later explicit resets are separate operations.

## Documentation cleanup: factorio-docs-only

Owner requested concise Factorio-only documentation with no code edits. Audited tracked Markdown, consolidated plans/history, retained runtime/worker/recovery/acceptance commands and removed superseded application material. Working in an isolated current-main worktree to preserve concurrent root changes.

Validation passed: all 30 remaining documentation files have no removed-topic references or broken local Markdown links; the diff against integrated main contains only Markdown changes. Documentation shrank from roughly 77,000 to 6,500 words. Concurrent source changes and the active inference handoff were preserved. No runtime tests were needed for this documentation-only edit. The development task records the pushed commit. Next work: follow the Factorio roadmap and live board; real-provider demo evidence remains outstanding.


## Completed: factorio-stack-review

Reviewing main at `a9a9c9a` in an isolated worktree. Scope: Factorio runtime/bridge, inference workers, shared database/client, dashboards, deployment/recovery and acceptance coverage. No implementation edits. Completed review: 15 prioritized findings in [the report](../factorio-stack-review.md). Reproduced cross-language hash divergence, rejection quarantine, movement during pause and SIGKILL receipt rollback with unchanged history. Passed 36 Factorio units, 16 inference checks, board integration, root/dashboard/module typechecks and real-engine production/graceful restart. No provider calls or implementation fixes. Next: encoding/rejections, recovery/supervision, leases and inference-specific acceptance before live release. Pushed review commit is recorded on task `factorio-stack-review`.


Review follow-up: All 15 findings are tracked on Development with evidence, acceptance requirements and **push when finished**. Fourteen new Factorio tasks remain open (6 High, 6 Normal, 2 Low); identity authorization is consolidated into concurrently added High task `board-auth-tailnet`, and our duplicate is cancelled. `factorio-history-scale` covers Lua receipt scanning; `board-history-scale` covers shared subscriptions/rendering. Existing assignments were preserved; freeplay capability work depends on `factorio-ci-fault-acceptance`. Start with `factorio-wire-canonicalization` and `factorio-rejection-receipts`, then recovery/supervision, lease renewal and the inference verifier.


## Completed: factorio-rejection-receipts

Implemented durable terminal failure receipts for valid scoped rejected operations; malformed envelopes/foreign histories still fail admission, and rejecting a second request preserves the actor’s current busy operation. Worker tests prove next-turn feedback and restart without replay. Passed 18 inference tests, root typecheck, real-engine rejection/replay/restart/conservation checks and the existing production/graceful-restart fixture. `factorio/check-rejections.py` is documented in the runtime guide. Canonicalization owner’s files were preserved; board result records the pushed commit.


## Completed: factorio-inference-lease-renewal

Implemented independent 15-second resource renewal during model calls/pause, serialized refreshes, five-second renewal timeout, and cancellation on lost/expired/uncertain leases without reacquiring peer resources. Expired peer reservations are omitted from model context and do not prevent atomic acquisition. Rules/inference workers share the entity namespace; old-version workers must be stopped before mixing versions. Passed all 46 Factorio unit tests, root typecheck and bundled worker build; the board result records the pushed commit. Next independent work: crash/save recovery, inference supervision and current-path verification.


## Completed: factorio-wire-publication

Imported codex-swarm’s canonicalization commit with authorship preserved and corrected accepted scientific-notation/binary-multiplication edge cases. Decimal-string validation and fixed-point serialization now agree for tiny values, negative zero, engine fractions and bounds; excessive precision is rejected by both languages and disclosed to the model. All 48 Factorio unit tests, root typecheck, worker build, actual Python bridge vectors, engine rejection/replay/restart and production/graceful restart checks passed. The publication task records the pushed commit; its original owner was notified to close `factorio-wire-canonicalization`. No provider calls or operator save changes. Remaining High work: crash/save recovery, supervision and inference live verification.

## Ready-agent publication
Integrating daily-loss 8799ad4 and Factorio pause/history/checkpoint/backup/CI/audit commits. Supervision already published by codex-board-3; call-budget publication coordinated with them. Review corrected pending-index recovery for legacy saves and restricts checkpoint selection to autosaves. Running full isolated checks and real-engine fixtures before direct main push. Owner also requests clearing blocked tasks once publication completes.

Publication validation passed: check:all (197 unit tests, generated bindings, isolated research/Phase 1/executor); eight Factorio fault-suite files and full typecheck; supervisor/launcher/worker bundles; real-engine production/rejections/save-restart; Factorio backup payload roundtrip; newest-autosave selection; verifier passing/incomplete fixtures. Imported commits preserve original authors. Credential-isolation b65337e returned to author for completion because risk worker and fixtures still need migration.
