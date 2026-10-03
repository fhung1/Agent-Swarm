import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBoardConfig } from './config.ts';
export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export function loadBoardConfig() {
  return parseBoardConfig(JSON.parse(readFileSync(process.env.BOARD_CONFIG ?? resolve(projectRoot, 'message-board/instances.json'), 'utf8')));
}
