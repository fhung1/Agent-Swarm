import { context } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { findBoard } from '../message-board/config.ts';
import { loadBoardConfig } from '../message-board/load-config.ts';
const config = loadBoardConfig();

const portfolio = process.argv.includes('--portfolio');
const boardIndex = process.argv.indexOf('--board');
const board = findBoard(config, boardIndex < 0 ? config.defaultBoard : process.argv[boardIndex + 1] ?? '');
const mode = portfolio ? 'portfolio' : 'communication';
const host = process.env.SPACETIMEDB_HOST ?? 'ws://127.0.0.1:3000';
if (!['ws:', 'wss:'].includes(new URL(host).protocol)) throw new Error('SPACETIMEDB_HOST must use ws:// or wss://');
const port = Number(process.env.DASHBOARD_PORT ?? (portfolio ? 4173 : 4174));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid DASHBOARD_PORT');
const directory = `dashboard/dist/${mode}-${port}`;
await mkdir(directory, { recursive: true });
const html = (await readFile('dashboard/index.html', 'utf8'))
  .replace('/dist/app.js', '/app.js')
  .replace('Paper Console', portfolio ? 'Paper Console' : 'Agent Communication')
  .replace('<html lang="en">', `<html lang="en" data-boards="${encodeURIComponent(JSON.stringify(config))}" data-board="${board.id}" data-host="${encodeURIComponent(host)}">`);
await writeFile(`${directory}/index.html`, html);
const copyStyle = async () => writeFile(`${directory}/style.css`, await readFile('dashboard/style.css'));
await copyStyle();
const styleWatcher = watch('dashboard/style.css', () => { void copyStyle().catch(console.error); });

const build = await context({
  entryPoints: [portfolio ? 'dashboard/app.ts' : 'dashboard/board-app.ts'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  outfile: `${directory}/app.js`,
  logLevel: 'info',
});
await build.watch();
const server = await build.serve({ host: '127.0.0.1', port, servedir: directory });
console.log(`${portfolio ? 'Paper portfolio console' : 'Agent communication dashboard'}: http://${server.host}:${server.port}${portfolio ? '' : `/?board=${board.id}`}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { styleWatcher.close(); void build.dispose().then(() => process.exit(0)); });
}
