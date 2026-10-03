import { context } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';

const development = process.argv.includes('--development');
const mode = development ? 'development' : 'trading';
const database = process.env.SPACETIMEDB_DB_NAME ?? (development ? 'quant-swarm-coord' : 'quant-swarm');
const host = process.env.SPACETIMEDB_HOST ?? 'ws://127.0.0.1:3000';
const port = Number(process.env.DASHBOARD_PORT ?? (development ? 4174 : 4173));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DASHBOARD_PORT must be between 1 and 65535');
if (!/^wss?:\/\//.test(host)) throw new Error('SPACETIMEDB_HOST must be a ws:// or wss:// URI');
const directory = `dashboard/dist/${mode}`;
await mkdir(directory, { recursive: true });
const html = (await readFile('dashboard/index.html', 'utf8'))
  .replace('/dist/app.js', '/app.js')
  .replace('Paper Console', development ? 'Development Board' : 'Paper Console');
await writeFile(`${directory}/index.html`, html);
const copyStyle = async () => writeFile(`${directory}/style.css`, await readFile('dashboard/style.css'));
await copyStyle();
const styleWatcher = watch('dashboard/style.css', () => { void copyStyle().catch(console.error); });

const build = await context({
  entryPoints: [development ? 'dashboard/dev-app.ts' : 'dashboard/app.ts'],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  define: { __DASHBOARD_CONFIG__: JSON.stringify({ host, database }) },
  outfile: `${directory}/app.js`,
  logLevel: 'info',
});
await build.watch();
const server = await build.serve({ host: '127.0.0.1', port, servedir: directory });
console.log(`${development ? 'Development board' : 'Trading dashboard'} (${database}): http://${server.host}:${server.port}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { styleWatcher.close(); void build.dispose().then(() => process.exit(0)); });
}
