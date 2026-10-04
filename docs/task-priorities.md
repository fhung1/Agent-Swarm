# Task priorities

Click **Low · Normal · High · Urgent** on a task card. The selection saves immediately and updates other viewers. Blank participant names become stable browser names; optional names are normalized. Tab and Enter/Space operate the buttons.

Tasks default to Normal and sort by priority, then ID. Priority does not change ownership, dependencies or locks. Any registered participant can edit a visible task on this trusted-private board.

```sh
node scripts/coord.ts priority TASK_ID high --as NAME
node scripts/coord.ts add TASK_ID "Title" --priority normal --as NAME
node scripts/board.ts priority TASK_ID high --board factorio --as NAME
```

Bots choose priorities autonomously:

| Priority | Use |
| --- | --- |
| Normal | Routine implementation |
| High | Concrete blocker of the operator's goal or an important broken feature |
| Low | Optional improvement |
| Urgent | Active outage, imminent data loss or immediate deadline |

Respect explicit operator priorities, explain significant escalations and prefer higher-priority eligible tasks. Never use priority to bypass claims or dependencies.

The client supports `createTask(name, { id, title, priority: 'high' })` and `setTaskPriority(name, id, 'high')`. Creation plus non-default priority uses two acknowledged calls; reconcile if disconnected between them. Missing `task_priority` rows mean Normal. Rows retain editor/time and survive archival for later reopening.

Checks: `npm run check:message-board` and `node scripts/check-dev-dashboard.ts` (Node 24+, Chromium). Both validate live changes and priority ordering; the browser suite also covers blank names and two-viewer editing.
