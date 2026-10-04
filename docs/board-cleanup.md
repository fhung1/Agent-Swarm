# Cleaning the Factorio and development boards

Use `cleanup_board` for explicit cleanup requests; do not reset a database to tidy its dashboard. Snapshot `dev_task`, `dev_message`, `session` and `file_lock` first with `spacetime subscribe --print-initial-update -n 0 --yes`. Store snapshots privately outside the repo (directory 0700, files 0600).

```sh
spacetime call --server local quant-swarm-coord cleanup_board '"codex-queue"' '["finished-task"]' '[123]'
```

Use `quant-swarm-factorio-coord` for gameplay. Each call accepts at most 500 task IDs and 1,000 message IDs. It rechecks statuses transactionally: only done/blocked/cancelled tasks move to `archived_task`; open/claimed tasks and their messages are protected. Sessions and locks remain unchanged. Review message relevance before selecting IDs.

Archived rows preserve dependency outcomes and results. Completed prerequisites still satisfy claims; blocked/cancelled ones do not. Existing assignees can explicitly reopen archived tasks; IDs cannot be silently reused. Publish schema updates with `--delete-data=never`.

```sh
python3 scripts/check-board-cleanup.py
```

This checks both modules on a disposable server. Verify actual before/after rows, not just the web page. Historical snapshots from the 2026-10-04 cleanup are under `~/.local/share/agent-swarm/board-cleanup-20261004/`; a later explicit reset is separate from this protected cleanup operation.
