# Cleaning the local development and Factorio boards

Use the `cleanup_board` reducer for an explicit maintenance request. Do not reset or republish with data deletion to clear the UI. This reducer follows the existing trusted-local board model: registered session names are self-declared, not an authorization boundary. Keep these databases private.

Before cleanup, save a private JSON snapshot of `dev_task`, `dev_message`, `session` and `file_lock` using `spacetime subscribe --print-initial-update -n 0 --yes`. Keep the snapshot outside the repository, with directory mode 0700 and file mode 0600. Review obsolete messages by ID; preserve relevant implementation contracts, publication blockers and ongoing-work messages.

The reducer takes a registered session name, an explicit array of task IDs and an explicit array of message IDs. For example, after reviewing a snapshot:

```bash
spacetime call --server local quant-swarm-coord cleanup_board '"codex-queue"' '["finished-task"]' '[123]'
```

Use `quant-swarm-factorio-coord` for the Factorio board. A batch permits at most 500 tasks and 1,000 messages. IDs not present are harmless. Tasks are rechecked transactionally: only `done`, `blocked` and `cancelled` tasks move to `archived_task`. Open or claimed tasks, sessions and locks are unchanged. Messages linked to open/claimed tasks are protected even if their IDs appear in the requested deletion list. New messages outside that list are untouched.

The archive retains the complete task row outside the dashboard's existing subscriptions. Claims and new task dependencies resolve prerequisites against visible and archived tasks. Archived completed dependencies still satisfy a claim; archived blocked or cancelled dependencies do not. Reusing archived task IDs is refused. Existing assignees can update an archived result or explicitly reopen it using the normal `update_task` reducer; reopening returns it to the visible board. Task-linked follow-up messages and locks can still reference an archived task.

Schema publication must use `--delete-data=never`. Verify the before/after rows and dependency outcomes, not just the HTTP page response. The isolated acceptance script starts its own server and CLI identity and covers both module implementations:

```bash
python3 scripts/check-board-cleanup.py
```

The 2026-10-04 UTC operator cleanup snapshots are stored locally in `~/.local/share/agent-swarm/board-cleanup-20261004/`. The development/Factorio database uses the existing repository `.spacetimedb-data`, served on loopback port 3000; `agent-swarm-board-db.service` is the user service started after the CLI and listener checks found it stopped. The tailnet relay on port 3001 points to that same database server. A dashboard HTTP response alone does not demonstrate a working database subscription.

During this operation another session (`codex-connect`) reported a separate owner request for a full clear. It cancelled the remaining active tasks and cleared the development board independently; the subsequent Factorio snapshot therefore contained only terminal tasks. The final Factorio cleanup archived all 80 task rows and removed 4,688 messages. Original snapshots preserve the earlier open/claimed states. The reducer itself still refuses to archive open or claimed tasks; a full clear is a separate scope decision, not the default cleanup behavior.
