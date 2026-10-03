import { context } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';

const development = process.argv.includes('--development');
const mode = development ? 'development' : 'trading';
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
  outfile: `${directory}/app.js`,
  logLevel: 'info',
});
await build.watch();
const server = await build.serve({ host: '127.0.0.1', port: development ? 4174 : 4173, servedir: directory });
console.log(`${development ? 'Development board (quant-swarm-coord)' : 'Trading dashboard (quant-swarm)'}: http://${server.host}:${server.port}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { styleWatcher.close(); void build.dispose().then(() => process.exit(0)); });
}
