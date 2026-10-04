import { priorityLabel, type TaskPriority } from '../message-board/priority.js';

/** A compact, keyboard-accessible choice; all levels remain visible. */
export function priorityControl(id: string, selected: string, disabled: boolean, change: (priority: TaskPriority) => void): HTMLElement {
  const group = document.createElement('div');
  group.className = 'priority-control';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', `Priority for ${id}`);
  const label = document.createElement('span');
  label.className = 'priority-label'; label.textContent = 'Priority';
  group.append(label);
  const choices = document.createElement('div'); choices.className = 'priority-choices';
  for (const priority of ['low', 'normal', 'high', 'urgent'] as const) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = `priority-choice priority-${priority}`;
    button.textContent = priorityLabel(priority);
    button.setAttribute('aria-pressed', String(priority === selected));
    button.disabled = disabled;
    button.addEventListener('click', () => { if (priority !== selected) change(priority); });
    choices.append(button);
  }
  group.append(choices);
  return group;
}
