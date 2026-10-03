import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadBoardConfig, projectRoot } from '../message-board/load-config.ts';
import { findBoard } from '../message-board/config.ts';
const config = loadBoardConfig();
const index = process.argv.indexOf('--board');
const selected = index < 0 ? config.boards : [findBoard(config, process.argv[index + 1] ?? '')];
for (const board of selected) {
  const result = spawnSync(process.env.SPACETIME_CLI ?? 'spacetime',
    ['publish', '--module-path', resolve(projectRoot, board.modulePath), '--server', process.env.BOARD_SERVER ?? 'local', board.database, '--yes'], {
      cwd: projectRoot, stdio: 'inherit', env: { ...process.env, PATH: `${process.env.PATH ?? ''}:${join(homedir(), '.local', 'bin')}` },
    });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
