# Codex SEC updates handoff

## trading-sec-updates — in progress

- **Scope:** Add bounded SEC 10-K/A, 10-Q/A, and material 8-K ingestion with accession/as-of provenance, immutable history, idempotent polling, amendment supersession in selected evidence, and an update signal suitable for the position-review task.
- **Concurrency:** Holds `src/sec-ingestor.ts`, `src/sec-excerpts.ts`, `src/sec-narrative.ts`, `src/sec-updates.ts`, `src/sec-updates.test.ts`, `src/agents/evidence.ts`, `src/agents/evidence.test.ts`, `docs/sec-updates.md`, and this handoff. Avoid the reducer/schema/view/bindings files held by `codex-scout`.
- **Next:** Review SEC submissions and existing source/fact limits, implement pure bounded selection/extraction helpers and evidence supersession, add fixture checks, document cadence/review limitations, then commit and push before starting another task.
- **Limitations:** `trading-position-reviews` is not implemented yet; this work must preserve an auditable event signal without claiming that an unavailable review worker consumed it. No live SEC requests are part of the fixture checks.
