# Prompt for a local Factorio demo agent

Copy the text below into a coding agent running **on the computer with your Factorio client**. Give it access to a local checkout of `fhung1/Agent-Swarm`.

---

I want a visible, running, ten-agent Factorio demo on **this computer**. Work in my local `fhung1/Agent-Swarm` checkout. Do the implementation, setup, testing, and launch for me; give me exact join and dashboard URLs at the end. Do not SSH into the remote server or use its Factorio installation, world, or SpacetimeDB databases.

Factorio is already installed here. Detect my operating system, Factorio executable, installed version, and mods. Reuse my existing installation and preserve my saves. The repository's pinned runtime was tested with Factorio 2.0.77 on Linux; adapt paths and startup for this machine. If my installed version is incompatible, explain the mismatch before replacing or upgrading the game. Use a fresh disposable world and a matching `agent-swarm` mod.

Read `AGENTS.md`, `FACTORIO_IMPLEMENTATION_TASKS.md`, `docs/factorio-pilot-contract.md`, `docs/factorio-operation-journal.md`, and the current `factorio/README.md`. Fetch the latest main branch while preserving local changes. Check which demo files and shared-board features are actually present; integrate or implement missing pieces instead of assuming a documented command exists. Follow the repository coordination board, file locks, checks, handoff, commit, and push instructions for code you change.

Launch these components locally:

1. SpacetimeDB and a **separate Factorio gameplay database** named `quant-swarm-factorio-coord`, published from the shared `message-board` module. Keep the development board and its history separate. Start the generic message-board dashboard with Factorio selected.
2. A private Factorio world with ten visible scripted characters, a bounded starter fixture, a loopback RCON interface, and a game address reachable by my installed graphical client. Do not modify my personal worlds or saves.
3. Ten independent rules-worker processes with separate saved board identities, actor IDs, and operation journals. They must claim gameplay tasks and coordinate through board messages and resource reservations. No paid inference or model credentials are needed for this demo.
4. Ten five-iron-plate production tasks. Run them against the actual game. Verify ten different actor inventories each hold five plates, that 50 matching game receipts and board action results exist, and that the shared ore/coal accounting is correct. A board completion message by itself is insufficient.
5. A bounded viewing period with the avatars visibly moving after production. Keep the game, workers, and dashboard running long enough for me to join and watch. Label the viewing activity separately from production.

Add a navigation list to the dashboards so I can open all **currently running** dashboards, including Development and Factorio, from each one. Show their actual local URLs and availability. Keep the Factorio board separate from the development board; use the same shared board feature and UI.

Test a real client join on this computer. Open the Factorio client and the Factorio dashboard if your desktop tools allow it; otherwise give me the single exact click/entry needed to join. Verify game version/mod compatibility, actual moving characters near spawn, live board messages, and pause/resume. Include stop/restart commands and where logs and receipts live. If a test fails, fix and rerun it. Do not declare a live demo verified from unit tests or a headless server alone.

When done, tell me what is running, the join address, dashboard links, tested versions, counts/evidence for ten agents and 50 plates, and any remaining limitations. Preserve the separate development board and all existing local work.
