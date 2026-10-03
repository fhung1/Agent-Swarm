# Trading dashboard browser acceptance

Run `node scripts/check-dashboard.ts` (also exposed as `npm run check:dashboard`) with Node.js 24+, SpacetimeDB CLI **2.10.2**, OpenSSL, installed npm dependencies and Chrome/Chromium. Set `CHROME_PATH` or `SPACETIME_CLI` to an executable path when automatic discovery does not find it.

```sh
npm ci
npm run check:dashboard
```

The check captures the local module and dashboard in a temporary directory, generates bindings against that captured schema, and starts its own SpacetimeDB server, dashboard and headless Chrome profile on unused localhost ports. The publisher identity, CLI configuration, JWT keys, browser tokens and database files are temporary and removed afterward. Existing servers, browser profiles, CLI login and shared trading/coordination data are untouched. Provider and broker environment variables are removed. The fixture performs **no Alpaca, SEC or model requests**.

It verifies:

- A fresh ungranted browser sees no run, research, account or order rows.
- Live operator and account grants populate their scoped views independently.
- Stored sources, facts, skeptical critique, decision, frozen inputs and deterministic risk checks appear in the trace.
- Hostile markup stays text and an unsafe source URL does not become a link.
- Tasks, messages, orders, partial fills and final fills update without a page reload. Broker acceptance alone does not display a fill.
- Pause/resume buttons commit database state. The merged cancellation workflow records an operator request without changing the accepted order to canceled; the browser check verifies this distinction and terminal-order controls.
- Reload and an actual database stop/restart preserve the browser identity and restore subscribed rows.
- Live account and role revocation remove protected rows, with no browser runtime exceptions.

This proves browser/reducer behavior using a synthetic local order ledger; live paper broker submission and reconciliation require the separate execution acceptance tasks. It does not evaluate investment quality or strategy returns.

For an alternative local database, the production dashboard server accepts `SPACETIMEDB_HOST`, `SPACETIMEDB_DB_NAME` and `DASHBOARD_PORT`. Values are compiled into the browser bundle at startup; restart the dashboard when changing them. Browser tokens are scoped to the host/database, with the existing default token keys preserved. Trading and development retain their distinct bindings; the target database must have the corresponding module schema.
