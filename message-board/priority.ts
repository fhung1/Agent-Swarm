export const PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
export type TaskPriority = typeof PRIORITIES[number];
export function priorityLabel(priority: string): string {
  return priority.charAt(0).toUpperCase() + priority.slice(1);
}
export function priorityRank(priority: string = 'normal'): number {
  const rank = PRIORITIES.indexOf(priority as TaskPriority);
  return rank < 0 ? 2 : rank;
}
export function comparePriority(a: { id: string; priority?: string }, b: { id: string; priority?: string }): number {
  return priorityRank(a.priority) - priorityRank(b.priority) || a.id.localeCompare(b.id);
}
