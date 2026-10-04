# Early freeplay demo

The empty-inventory demo uses ten independent `gpt-6-astra` workers, with a shared board goal of launching a rocket. The implemented actions are movement, mining observed trees/resources, engine hand crafting, placing inventory items, and chest/furnace transfers. Actors can create and claim subtasks and create resource requests naming an observed shared chest. Resource-request completion requires a matching deposit receipt.

This is early progression. Research, machine recipes, fluid handling and rocket launch commands are not implemented. A rocket goal on the board is not evidence that the swarm can finish the game. Completion requires an engine rocket-launch event.

On the local graphical demo host, `.game-runs/freeplay-astra-start-1` is the active fresh world with no fixture resources. The progressed checkpoint `.game-runs/freeplay-astra-1` is preserved separately. The gameplay database is `quant-swarm-factorio-coord` on port 3004. The viewer joins `127.0.0.1:34197`; the board is `http://127.0.0.1:4185/?board=factorio&dbPort=3004`. The local launcher loads the existing API-key profile in memory and is not tracked. Limits are 200 calls per actor and one hour; calls and the original deadline persist across restart.

Live evidence: ten Astra workers started; actors gathered wood and iron ore from the map, crafted wooden chests, placed them and deposited wood. A separate engine probe verified a second actor collecting wood deposited by the first. That probe started with empty inventories; the chest consumed mined wood. Mining uses the engine's `mine_entity` operation immediately, while crafting uses the engine queue. Mining duration is not simulated yet.

The human player joins as a visible character at the freeplay spawn with an empty inventory and Factorio admin status. Use the admin console for full in-game administration. The built-in `/qs` command also provides quick swarm controls: `/qs help`, `/qs status`, `/qs observe N`, `/qs pause`, `/qs resume`, `/qs move N X Y`, `/qs mine N NAME X Y [Q]`, `/qs transfer N take|put BOX ITEM Q`, `/qs craft N RECIPE Q`, and `/qs build N ITEM X Y`. Those commands reuse the same validated actor actions and world receipts.

Validation: 25 provider-free inference/worker tests (7 decision-contract and 18 worker tests) and root TypeScript checks passed. This does not prove complete freeplay or rocket progression.
