import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createConnection } from 'node:net';
import { parseSwarmConfig, planProcesses } from '../src/swarm-plan.ts';
let failures=0;
function check(label:string,ok:boolean,detail=''){console.log(`${ok?'PASS':'MISSING'} ${label}${detail?`: ${detail}`:''}`);if(!ok)failures++;}
let secrets=['ALPACA_API_KEY','ALPACA_API_SECRET','SEC_USER_AGENT','OPENAI_API_KEY'];
const file=resolve('config/swarm.json');
if(existsSync(file)){try{const config=parseSwarmConfig(readFileSync(file,'utf8'));secrets=[...new Set(planProcesses(config).flatMap(p=>p.secrets))];check('Paper config',true);}catch(error){check('Paper config',false,String(error));}}
else check('Paper config',false,'Run npm run pilot:prepare after exporting paper keys; it fills in the account ID');
for(const name of secrets)check(name,!!process.env[name]?.trim());
check('Paper worker build',existsSync(resolve('dist/executor.js'))&&existsSync(resolve('dist/risk-worker.js')));
try{check('Local SpacetimeDB', (await fetch('http://127.0.0.1:3000/v1/ping',{signal:AbortSignal.timeout(2000)})).ok);}catch{check('Local SpacetimeDB',false,'npm run db:start');}
check('Minecraft server/runtime',existsSync(resolve('games/.runtime/minecraft/server.jar'))&&existsSync(resolve('games/.runtime/minecraft/eula.txt')));
check('Minecraft worker build',existsSync(resolve('games/dist/src/worker.js')));
const minecraft=await new Promise<boolean>(done=>{const socket=createConnection({host:'127.0.0.1',port:25565});let settled=false;const finish=(value:boolean)=>{if(settled)return;settled=true;socket.destroy();done(value);};socket.setTimeout(2000,()=>finish(false));socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));});
check('Private Minecraft listener',minecraft,'node games/scripts/server.ts start');
console.log('Factorio live testing is deferred by the owner. This preflight makes no broker/model calls and does not replace acceptance checks.');
process.exitCode=failures?1:0;
