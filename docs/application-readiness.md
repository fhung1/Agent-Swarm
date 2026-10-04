# Application readiness checks

The readiness mode reports what is implemented, what passed an isolated fixture run, what has live acceptance evidence, and what blocks release. It does not infer readiness from a successful build or from a missing test being skipped.

Run it with Node.js 24 or newer:

```sh
node scripts/check-all.ts --app all --dry-run
node scripts/check-all.ts --app factorio --run-fixtures
node scripts/check-all.ts --app minecraft --run-fixtures
node scripts/check-all.ts --app paper --run-fixtures
```

`--app` accepts `factorio`, `minecraft`, `paper`, and `all` (`alpaca` and `trading` are aliases for `paper`). Dry-run is the default. The command writes one JSON manifest to stdout; redirect stdout to save it. A blocked release emits the manifest and exits with code 2. Exit code 0 means every required live gate has commit-matched evidence. Use `npm run check:all -- --app paper --run-fixtures` when the shell's Node.js is already version 24 or newer.

## What each mode checks

- **Factorio:** dry-run checks the pinned runtime binary path and source/config presence without launching Factorio. Fixture mode runs the existing TypeScript unit tests and, when the pinned binary is installed, `factorio/check-runtime.py` and `factorio/check-production.py`. Those scripts use disposable worlds and ephemeral ports. The future F3 fault suite is run only when its `scripts/check-factorio.ts` or `.py` entry point exists and accepts the documented `--isolated --fixture --data-dir DIR` contract. An engine smelting check does not satisfy F3, ten-worker, dashboard, independent review, or live-demo acceptance.
- **Minecraft:** dry-run probes Java and checks a server-jar path only if `MINECRAFT_SERVER_JAR` is set. It never starts a server, reads or accepts the EULA, or writes a world. Fixture mode runs existing `src/minecraft/*.test.ts` files and the M5 entry point `scripts/check-minecraft.ts` or `.py` only when present, with `--isolated --fixture --data-dir DIR`. Missing implementation or M5 suite remains blocked.
- **Paper trading:** dry-run checks the local SpacetimeDB CLI version without connecting to a database or Alpaca. Fixture mode delegates to the existing `scripts/check-all.ts` full acceptance runner, which creates a disposable SpacetimeDB instance and removes model and broker credentials. This verifies local behavior only; it never submits a paper order or marks Alpaca connectivity live.

Fixture outputs are summarized by SHA-256 in `suiteRuns`; raw traces are not included in the manifest. The `hashes` list fingerprints relevant source, test, configuration-example and lock files. It intentionally omits local secrets and credential values. The manifest also records the source commit and whether the checkout was clean. Dry-run performs only local version/path/file reads and does not create files, start app services, contact external endpoints, run model calls, accept EULAs, send broker orders, or access application saves.

## Status and release evidence

Each gate uses one of these statuses:

| Status | Meaning |
| --- | --- |
| `implemented` | The code or fixture entry point exists; it was not verified by this invocation. |
| `fixture-verified` | The isolated fixture command ran and passed in this invocation. |
| `live-verified` | Required live acceptance gates passed and a commit-matched evidence report and all referenced artifact hashes validated. |
| `blocked` | Required code, suite, runtime, or acceptance evidence is absent or failed. |

The top-level `releaseStatus` is `live-verified` only when its live-evidence gate is verified. A unit test or disposable fixture cannot mark an application ready to run with an operator. Missing Factorio F3 or Minecraft M5 suites are integration blockers, not skipped green checks.

For a future live acceptance run, save a JSON report with this shape and pass it as `--evidence FILE`; otherwise the runner looks for `reports/readiness/<app>-live.json`:

```json
{
  "schemaVersion": 1,
  "application": "paper",
  "result": "passed",
  "commit": "full 40-character source commit",
  "completedGates": ["trading-paper-order-acceptance"],
  "artifacts": [{ "path": "paper-order-acceptance.json", "sha256": "64 lowercase hex characters" }]
}
```

Use the application ID `factorio`, `minecraft`, or `paper`. `completedGates` must contain all required IDs for that application:

- Factorio: `factorio-f2-ten-workers`, `factorio-f2-dashboard`, `factorio-f3-fault-suite`, `factorio-live-demo-guide`, `factorio-acceptance-review`.
- Minecraft: `minecraft-pilot-choices`, `minecraft-server`, `minecraft-commands`, `minecraft-worker`, `minecraft-shared-state`, `minecraft-ten-agents`, `minecraft-recovery`, `minecraft-sharing-eval`, `game-operator-dashboard`, `minecraft-live-demo-guide`.
- Paper: `trading-pilot-choices`, `trading-ops-deployment`, `trading-connectivity-acceptance`, `trading-risk-live-acceptance`, `trading-model-acceptance`, `trading-paper-order-acceptance`, `trading-order-stream`, `trading-operator-cancel`, `trading-dashboard-acceptance`, `trading-position-reviews`, `trading-corporate-actions`, `trading-strategy-contract`, `trading-evaluation-alerts`, `trading-live-demo-guide`.

Artifact paths in the report are relative to that report. Every file must exist and match its SHA-256. The report commit must equal the current `HEAD`, and the checkout must be clean. Evidence reports do not replace the underlying board tasks or their review requirements; they provide a verifiable input to the readiness manifest. No credential or account identifier belongs in the report.

The Factorio F3 suite and Minecraft M5 recovery suite are still separate implementation tasks. This readiness runner calls their established entry points when they land instead of duplicating their assertions. The paper mode likewise delegates to the existing isolated Phase 1 runner, while actual account, order, dashboard, position-monitoring and release acceptance remain independent live gates.
