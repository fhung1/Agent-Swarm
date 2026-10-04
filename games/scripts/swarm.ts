import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { connectDatabase, DATABASE } from '../src/database.ts';

const cli=process.env.SPACETIME_CLI??'spacetime';
const server=process.env.SPACETIME_SERVER??'local';
const runId=process.env.GAME_RUN_ID??'minecraft-pilot';
const count=Number(process.env.GAME_AGENT_COUNT??10);
if(!Number.isInteger(count)||count<1||count>10)throw new Error('GAME_AGENT_COUNT must be 1-10');
const names=Array.from({length:count},(_,i)=>`qs-agent-${i+1}`);
function call(reducer:string,args:(string|number)[]){execFileSync(cli,['call','--server',server,DATABASE,reducer,...args.map(a=>JSON.stringify(a))],{stdio:['ignore','pipe','pipe']});}
const command=process.argv[2];
if(command==='setup'){
  mkdirSync('.runtime',{recursive:true});
  const marker=resolve('.runtime',`${runId}.json`);
  if(!existsSync(marker)){
    try{call('create_run',[runId,process.env.GAME_GOAL??'Collect five oak logs each and craft a crafting table; share local resource locations',process.env.GAME_INFO_MODE??'knowledge',Number(process.env.GAME_MAX_CALLS??200),Number(process.env.GAME_MAX_TOKENS??1000000),Number(process.env.GAME_MAX_CONCURRENT??2)]);}catch(error){if(!String((error as {stderr?:Buffer}).stderr??error).includes('Run already exists'))throw error;}
    writeFileSync(marker,JSON.stringify({runId,names}));
  }
  if((process.env.GAME_BRAIN??'rules')!=='rules'){
    const version=process.env.GAME_PRICING_VERSION;
    if(!version)throw new Error('GAME_PRICING_VERSION is required when GAME_BRAIN uses a model');
    const model=process.env.AGENT_MODEL??(process.env.GAME_BRAIN==='fixture'?'local-fixture':process.env.GAME_BRAIN==='claude'?'claude-opus-5-5':'gpt-6-astra');
    const rates=['GAME_INPUT_MICROS_USD_PER_MILLION','GAME_CACHE_READ_MICROS_USD_PER_MILLION','GAME_CACHE_WRITE_MICROS_USD_PER_MILLION','GAME_OUTPUT_MICROS_USD_PER_MILLION'].map(key=>process.env[key]);
    if(rates.some(value=>!value||!/^\d+$/.test(value)))throw new Error('All four GAME_*_MICROS_USD_PER_MILLION integer rates are required');
    const runCap=process.env.GAME_MAX_SPEND_MICROS;
    const workerCap=process.env.GAME_MAX_WORKER_SPEND_MICROS;
    if(!runCap||!/^\d+$/.test(runCap)||!workerCap||!/^\d+$/.test(workerCap))throw new Error('GAME_MAX_SPEND_MICROS and GAME_MAX_WORKER_SPEND_MICROS are required');
    call('configure_spend',[runId,version,model,...rates as string[],runCap,workerCap]);
  }
  for(const name of names){const conn=await connectDatabase(name,false);call('grant_member',[runId,conn.identity!.toHexString(),name]);conn.disconnect();}
  console.log(`Run ${runId}: ${count} workers registered and granted; start with swarm up`);
}else if(command==='pause'||command==='resume'||command==='close')call('set_run_status',[runId,command==='pause'?'paused':command==='resume'?'active':'closed']);
else if(command==='resolve-action'){
  const [id,status,...evidence]=process.argv.slice(3);if(!id||!status||!evidence.length)throw new Error('resolve-action ID completed|failed EVIDENCE');
  call('resolve_action',[id,status,evidence.join(' ')]);
}else if(command==='resolve-inference'){
  const [id,...evidence]=process.argv.slice(3);if(!id||!evidence.length)throw new Error('resolve-inference ID EVIDENCE');
  call('resolve_inference',[id,evidence.join(' ')]);
}
else if(command==='up'){
  const children=new Set<ChildProcess>();let stopping=false;
  const start=(name:string,attempt=0)=>{
    if(stopping)return;
    const env: NodeJS.ProcessEnv={...process.env,GAME_RUN_ID:runId,GAME_AGENT_NAME:name,AGENT_MODEL:process.env.AGENT_MODEL??'gpt-6-astra'};
    for(const key of ['ALPACA_API_KEY','ALPACA_API_SECRET','SEC_USER_AGENT'])delete env[key];
    const child=spawn(process.execPath,[resolve('dist/src/worker.js')],{env,stdio:['ignore','pipe','pipe']});children.add(child);
    for(const stream of [child.stdout!,child.stderr!])stream.on('data',bytes=>process.stdout.write(`[${name}] ${String(bytes)}`));
    child.on('error',error=>{console.error(`${name}: ${error.message}`);process.exitCode=1;});
    child.on('exit',code=>{children.delete(child);if(!stopping&&code!==0&&attempt<3)setTimeout(()=>start(name,attempt+1),Math.min(30000,1000*2**attempt));else if(!stopping&&code!==0)process.exitCode=code??1;});
  };
  const stop=()=>{stopping=true;for(const child of children)child.kill('SIGINT');setTimeout(()=>{for(const child of children)child.kill('SIGKILL');},5000).unref();};
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  for(const name of names)start(name);
}else if(command==='status'){
  const marker=resolve('.runtime',`${runId}.json`);console.log(existsSync(marker)?readFileSync(marker,'utf8'):'Run not set up');
}else throw new Error('Usage: swarm setup | up | pause | resume | close | status');
