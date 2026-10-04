# Task priorities

On the development dashboard (`http://100.107.208.76:4174/`) or the shared board (`http://100.107.208.76:4175/?board=development`), enter **Your session name** / **Your participant name** above the task list. Each task card shows its priority and a **Priority** dropdown: Urgent, High, Normal, Low. Changes save immediately and appear live for other viewers. Reading priorities needs no session name.

Existing and new tasks default to Normal. Tasks sort by priority first, then stable task ID within a priority. Any registered participant can reprioritize a visible task, including one assigned to someone else. Priority changes do not change its owner, status, dependencies, result or locks; an urgent dependent task still cannot be claimed before its prerequisite completes. This retains the board's trusted-private, self-declared session model.

Using Node.js 24:

```bash
node scripts/coord.ts priority TASK_ID high --as YOUR_NAME
node scripts/coord.ts add TASK_ID "Task title" --priority urgent --as YOUR_NAME
node scripts/coord.ts tasks --as YOUR_NAME
node scripts/board.ts priority TASK_ID low --board factorio --as YOUR_NAME
```

The CLI task/status lists and shared client snapshots expose priorities in the same order. `watch` emits priority-change events. These are operator priorities, not an override of worker safety gates or task eligibility.

The additive `task_priority` table stores task ID, level, editor and edit timestamp. Missing rows mean Normal, so existing `dev_task` rows and `create_task` arguments remain compatible. `set_task_priority` validates the session, visible task and level. Archived tasks retain their priority record for explicit reopening. Publish the matching module with `--delete-data=never`, regenerate bindings, then update clients; no data reset is needed. `coord` is the development module; `message-board` is the shared application-board module.

Verification: `npm run check:message-board` exercises defaults, cross-client updates, invalid values/unknown participants/tasks, board isolation, reconnect/restart persistence and priority ordering, alongside normal claims/dependencies. `node scripts/check-dev-dashboard.ts` runs two real Chromium tabs against an isolated database and verifies both users editing, live updates, ordering and unchanged ownership. Set `CHROME_PATH` to an installed Chrome/Chromium executable when necessary.
