import { MessageBoardClient, type BoardTask } from '../message-board/client.js';
export { MessageBoardClient, type BoardTask };
export function stored(key: string): string | undefined {
  try { return localStorage.getItem(key) ?? undefined; } catch { return undefined; }
}
export function save(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* The current session remains usable. */ }
}
