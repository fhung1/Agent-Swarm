# Executable paper pilot configuration

Use Node 24+ from the repository root. `config/paper-pilot.example.json` is an example, not an approved trading policy. It deliberately leaves the paper account ID and model names blank: select those and review every numeric limit before preparing a run. Symbols and numeric values illustrate the existing supervisor, not an investment recommendation.

Copy the example to `logs/pilot.local.json` (create `logs/` first; it is ignored by Git). Set `swarm.accountId` to the actual paper account ID, and set explicit supported model names for each configured model brain. The symbol universe in research, market data and risk policy must match. The benchmark is comparison metadata and does not have to be tradable. Choose a new run ID/policy version for a new pilot.

Provide credentials through the environment, never JSON: `ALPACA_API_KEY`, `ALPACA_API_SECRET`, `OPENAI_API_KEY` for Codex brains, and `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` for Claude brains. `SEC_USER_AGENT` must identify your application and real contact. This wrapper requires explicit environment auth for Claude; it does not probe local login profiles. Presence checks do not prove credential validity, account identity or feed entitlement. Existing adapters use the fixed Alpaca paper endpoint.

```bash
node scripts/pilot.ts check logs/pilot.local.json
node scripts/pilot.ts prepare logs/pilot.local.json
```

Preparation validates all inputs before writing anything, then creates `logs/pilots/<runId>/` containing the normalized pilot, risk policy and a compatible swarm config. It refuses to overwrite an existing directory. No credentials are copied and no network requests or trades occur. It prints commands for the existing supervisor; for run `pilot-1`:

```bash
node scripts/swarm.ts plan --config logs/pilots/pilot-1/swarm.json
node scripts/swarm.ts register --config logs/pilots/pilot-1/swarm.json
node scripts/swarm.ts grants --config logs/pilots/pilot-1/swarm.json
node scripts/swarm.ts grants --apply --config logs/pilots/pilot-1/swarm.json
node scripts/swarm.ts up --config logs/pilots/pilot-1/swarm.json
```

Start/publish the local database first using the README setup. Registration gives each process a stable identity; grants configure run budgets, roles, account/run access and the run-specific risk policy. `up` starts the paper executor as well as research and risk workers. Perform `trading-connectivity-acceptance` before that final command; a passed local configuration check is not live paper acceptance. The risk worker verifies the account returned by credentials against the policy account and enforces data freshness. Model and feed availability need real acceptance checks.

The pilot requires positive order, position, portfolio, open-order, daily-loss and freshness limits; long-only orders and an open market; SEC evidence; explicit model/token/concurrency/attempt budgets; and one risk worker/executor. Quote refresh must be faster than the allowed quote age. The risk worker also collects fresh inputs for each risk evaluation.

`holdingHorizonDays`, `reviewEveryHours` and `benchmark` are retained operator/evaluation metadata. Existing research runs once at supervisor startup: this wrapper does not implement recurring research, automatic thesis exits, position-review scheduling, dollar-cost accounting or benchmark-return calculation. Those remain the board's position-review/evaluation tasks. Until then, schedule operator reviews manually; do not restart a run expecting fresh thesis IDs. Model token budgets are enforced by existing run-limit reducers, not dollar-spend ceilings.
