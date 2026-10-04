# Factorio readiness report

```sh
node scripts/check-all.ts --app factorio --dry-run
node scripts/check-all.ts --app factorio --run-fixtures
```

Use Node 24+. Dry-run probes local runtime/source/configuration without starting a game. Fixture mode runs available unit and disposable engine checks. JSON goes to stdout; exit 2 means a required gate is blocked. A missing F3 suite is a blocker, not a skipped success.

Statuses distinguish `implemented`, `fixture-verified`, `live-verified` and `blocked`. Passing unit tests or one-actor smelting does not establish ten-worker, graphical or recovery acceptance.

For live evidence, pass `--evidence FILE` (default `reports/readiness/factorio-live.json`). The report needs `schemaVersion: 1`, `application: "factorio"`, `result: "passed"`, the full current commit, `completedGates`, and `artifacts` with relative paths and SHA-256 hashes. The checkout must be clean and all artifacts/hash checks must pass.

Required gate labels: `factorio-f2-ten-workers`, `factorio-f2-dashboard`, `factorio-f3-fault-suite`, `factorio-live-demo-guide`, `factorio-acceptance-review`. These are evidence labels, not proof that matching tasks remain on the live board. Never include secrets or mark a stub run as live verification.
