export interface BoardInstance {
  id: string;
  label: string;
  database: string;
  modulePath: string;
  showReservations?: boolean;
}
export interface BoardConfig { defaultBoard: string; boards: BoardInstance[] }
/** Shared validation for server, CLI and browser. Instances are data, not UI branches. */
export function parseBoardConfig(value: unknown): BoardConfig {
  if (!value || typeof value !== 'object') throw new Error('Invalid message-board configuration');
  const config = value as Partial<BoardConfig>;
  if (!Array.isArray(config.boards) || !config.boards.length) throw new Error('Configure at least one message board');
  const ids = new Set<string>();
  const databases = new Set<string>();
  for (const board of config.boards) {
    if (!board || !/^[a-z][a-z0-9-]{0,63}$/.test(board.id) || ids.has(board.id)) throw new Error('Board IDs must be unique lowercase names');
    if (typeof board.label !== 'string' || !board.label.trim() || board.label.length > 100) throw new Error(`Invalid board label: ${board.id}`);
    if (typeof board.database !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(board.database) || databases.has(board.database)) throw new Error('Each board must name a distinct database');
    if (typeof board.modulePath !== 'string' || !board.modulePath.trim()) throw new Error(`Missing module path: ${board.id}`);
    if (board.showReservations !== undefined && typeof board.showReservations !== 'boolean') throw new Error('showReservations must be boolean');
    ids.add(board.id); databases.add(board.database);
  }
  if (typeof config.defaultBoard !== 'string' || !ids.has(config.defaultBoard)) throw new Error('defaultBoard must name a configured board');
  return config as BoardConfig;
}
export function findBoard(config: BoardConfig, id: string): BoardInstance {
  const board = config.boards.find(item => item.id === id);
  if (!board) throw new Error(`Unknown board: ${id}. Choose ${config.boards.map(item => item.id).join(', ')}.`);
  return board;
}
