# Autonomous iron factory result — 2026-10-04

## Verified outcome

The five Luna actors, coordinated by one Astra overseer, completed the existing
iron factory run. The engine first reported `automation.verified=true` at tick
1612860, after two consecutive 30-second unattended production windows.
The gameplay goal task was then marked done by Astra.

During the qualifying minute, aggregate stored iron plates increased from 38 to
53. Existing bootstrap stock is excluded from that 15-plate increase. Each window
required fresh iron mining, coal mining, smelting and delivery; actor material
actions reset the proof.

After all inference processes stopped, the engine passed a third window.
At tick1616340 it reported 71 aggregate stored plates. The output chest (770)
contained 34 plates in the subsequent status snapshot; other containers retain
historical bootstrap stock. Production continued with agent mutations paused.

## Physical chain and provenance

- Natural coal drill641 and self-fuel inserter757 feed the coal transport route.
- Natural iron drill774 delivers ore directly into furnace773.
- Inserters764 and775 receive belt coal for the drill and furnace.
- Inserter765 transfers furnace plates into chest770; inserter767 is positioned
  to supply its fuel from the same coal route.
- Live inspection found coal at all three iron-cell fuel pickup belt positions.
- The original freeplay manifest records empty actor inventories and no supplied
  chest resources or furnaces. Bootstrap gathering, crafting and construction
  occurred before the unattended verification period.
- The monitor repaired software and inspected evidence. Astra chose gameplay
  assignments and layouts. Earlier operator-directed bootstrap interventions
  recorded in HANDOFF.md are not claimed as autonomous gameplay.

## Run limits and shutdown

The saved configuration remained one Astra overseer, five Luna actors, no total
time deadline and no call-count limit, with a shared $100 spending ceiling.

The final launcher ledger recorded $53.749406 charged and $8.935149 reserved for
usage not yet resolved. Reservations remain counted against the ceiling; this is
local ledger accounting, not independently reconciled provider billing.

All five actor journals had no pending game operation, and no inference role
process remained. Factorio and its viewer remain available; the dashboard
returned HTTP200 at http://127.0.0.1:4193/?board=factorio.

The original launcher exited1 because one idle actor required SIGKILL after
Astra's successful completion. The launcher now distinguishes completed-goal
cleanup from a failed coordinator or an incomplete run. This reporting fix was
tested without restarting the completed run.

## Scope

This proves the requested iron factory's 60-second unattended production gate,
with additional production after the agents stopped. It does not prove infinite
operation, rocket launch, a fresh-run reproducibility rate, or ten-agent
cooperation. Private saves, credentials and raw traces remain uncommitted.
