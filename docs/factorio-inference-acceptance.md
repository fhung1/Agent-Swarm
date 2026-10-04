# Factorio inference acceptance

This acceptance is deliberately separate from the engine worker. It uses a
deterministic `Ask` stub and never starts Factorio, connects to a board, or
makes a provider request. The worker may be considered ready for a paid/live
run only when it preserves these properties at its boundary.

## Decision boundary

For each actor turn, the worker must construct one context scoped to its
`runId`, `worldId`, `historyId`, and actor ID, then request exactly one strict
decision. The only accepted decisions are:

- `action`, carrying one locally valid `move`, `take`, or `put` command;
- `chat`, carrying a bounded message and optional valid recipient;
- `wait`, with a bounded wait duration; or
- `complete`, which remains a proposal until the real game observation proves
  the objective is complete.

The model cannot issue RCON text, shell commands, arbitrary command kinds, or
actions for another actor. Peer-message text is data, not instructions.

## Deterministic acceptance matrix

The runner will require all of the following without a provider key:

| Case | Required outcome |
| --- | --- |
| Valid wait | One stub call; no bridge submission. |
| Valid bounded action | The emitted command passes the existing protocol validator. |
| Invalid/malformed provider result | Reject the decision; no fallback action and no bridge submission. |
| Timed-out/aborted provider | Reject the decision; no bridge submission. |
| Wrong run, world, history, sender, or recipient in peer input | Omit it from the model context. |
| Oversize peer history | Keep a bounded recent subset and disclose the omission count. |
| Cross-actor action or paused/lost ownership state | Worker-side admission rejects it after inference and before bridge execution. |

The first six are contract-level checks. The final row is worker integration
acceptance and will be added once `factorio-inference-worker` exposes its
dependency-injected decision/bridge boundary.

## Live acceptance prerequisites

The ten-actor launch must use a new disposable world and an empty, dedicated
Factorio board created after the reset. Each actor needs a distinct board token,
agent name, stable actor ID, objective/prompt, finite call limit and finite
timeout. A live run records only the provider/model identifiers and bounded
decision/action audits; never credentials or raw secrets.

Before invoking a provider, the operator must set the selected provider key,
model, model/call/token budget and an explicit authorization to spend it. A
model refusal, timeout, malformed response, board disconnect, pause, or lost
claim stops further action for that actor and is visible in its journal.

The later `factorio-inference-live` acceptance must prove ten distinct prompted
actors, isolated board identities, bounded calls, at least one purposeful
same-scope peer message, and game receipts matching every accepted action. It
must separately report whether the objective completed; an accepted model
request is never evidence of a game action or completion.
