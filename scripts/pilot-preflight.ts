import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseSwarmConfig, planProcesses } from '../src/swarm-plan.ts';
let failures=0;
function check(label:string,ok:boolean,detail=''){console.log(`${ok?'PASS':'MISSING'} ${label}${detail?`: ${detail}`:''}`);if(!ok)failures++;}
let secrets=['ALPACA_API_KEY','ALPACA_API_SECRET','ALPACA_READ_API_KEY','ALPACA_READ_API_SECRET','SEC_USER_AGENT','OPENAI_API_KEY'];
const file=resolve('config/swarm.json');
if(existsSync(file)){try{const config=parseSwarmConfig(readFileSync(file,'utf8'));secrets=[...new Set(planProcesses(config).flatMap(p=>p.secrets))];check('Paper config',true);}catch(error){check('Paper config',false,String(error));}}
else check('Paper config',false,'Run npm run pilot:prepare after exporting paper keys; it fills in the account ID');
for(const name of secrets)check(name,!!process.env[name]?.trim());
if (secrets.includes('ALPACA_READ_API_KEY')) check('Separate Alpaca read key',
  !process.env.ALPACA_API_KEY || !process.env.ALPACA_READ_API_KEY || process.env.ALPACA_API_KEY !== process.env.ALPACA_READ_API_KEY,
  'Provision a restricted read key with a different key ID');
check('Paper worker build',existsSync(resolve('dist/executor.js'))&&existsSync(resolve('dist/risk-worker.js')));
try{check('Local SpacetimeDB', (await fetch('http://127.0.0.1:3000/v1/ping',{signal:AbortSignal.timeout(2000)})).ok);}catch{check('Local SpacetimeDB',false,'npm run db:start');}
console.log('Paper pilot preflight makes no broker/model calls and does not replace paper execution acceptance checks.');
process.exitCode=failures?1:0;
