#!/usr/bin/env node
// Exercise the actual production startWorld code, rather than a substitute server launcher.
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
const root=resolve(process.argv[2] ?? '.');
if (!existsSync(join(root,'src/factorio/runtime.ts'))) throw new Error('Pass the Factorio implementation checkout as the first argument');
const scratch=mkdtempSync(join(tmpdir(),'factorio-runtime-check-'));
// Keep artifacts after failures so the server log explains startup problems.
const source=`
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startWorld } from ${JSON.stringify(join(root,'src/factorio/runtime.ts'))};
import { createServer } from 'node:net';
import { createSocket } from 'node:dgram';
const config=JSON.parse(readFileSync('config/factorio-pilot.json','utf8'));
const tcp=createServer(); await new Promise(r=>tcp.listen(0,'127.0.0.1',r));
const udp=createSocket('udp4'); await new Promise(r=>udp.bind(0,'127.0.0.1',r));
config.rconPort=tcp.address().port; config.gamePort=udp.address().port;
await Promise.all([new Promise(r=>tcp.close(r)),new Promise(r=>udp.close(r))]);
config.runId='runtime-check';
const directory=${JSON.stringify(join(scratch,'world'))};
let world;
try {
  await assert.rejects(startWorld({...config,version:'0.0.0'},directory),/Expected Factorio/);
  world=await startWorld(config,directory);
  const original=world.worldId;
  await world.save(); await world.stop(); world=undefined;
  await assert.rejects(startWorld({...config,seed:config.seed+1},directory),/seed differs/);
  world=await startWorld(config,directory);
  assert.equal(world.worldId,original);
  console.log('PASS: production runtime starts, saves, restarts with same world ID, refuses version and seed mismatches.');
} finally {if(world) await world.stop();}
`;
writeFileSync(join(scratch,'check.ts'),source);
console.log(`Runtime check artifacts: ${scratch}`);
let result=spawnSync(join(root,'node_modules/.bin/esbuild'),[join(scratch,'check.ts'),'--bundle','--platform=node','--format=esm',`--outfile=${join(scratch,'check.mjs')}`],{cwd:root,stdio:'inherit'});
if (result.error) throw result.error;
if (result.status===0) result=spawnSync(process.execPath,[join(scratch,'check.mjs')],{cwd:root,stdio:'inherit',env:process.env});
if (result.error) throw result.error;
process.exitCode=result.status ?? 1;
if (process.exitCode===0) rmSync(scratch,{recursive:true,force:true});
