import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { connectDatabase, DATABASE } from '../src/database.ts';
import { recordId } from '../../src/ids.ts';

const runId=`worker-check-${Date.now()}`;
const env={...process.env,GAME_RUN_ID:runId,GAME_BRAIN:'fixture',GAME_MAX_STEPS:'2',GAME_STEP_MS:'1000',GAME_FIXTURE_DELAY_MS:'500',GAME_AGENT_COUNT:'10',GAME_MAX_CALLS:'50',GAME_MAX_TOKENS:'1000000',GAME_MAX_CONCURRENT:'2'};
const cli=process.env.SPACETIME_CLI??'spacetime';
function owner(reducer:string,args:(string|number)[]){execFileSync(cli,['call','--server','local',DATABASE,reducer,...args.map(a=>JSON.stringify(a))],{stdio:['ignore','pipe','pipe']});}
async function launch(command:string,override:Record<string,string>={}){
  const child=spawn(process.execPath,['dist/scripts/swarm.js',command],{env:{...env,...override},stdio:['ignore','pipe','pipe']});
  const timer=setTimeout(()=>child.kill('SIGTERM'),120000);let log='';
  for(const stream of [child.stdout!,child.stderr!])stream.on('data',data=>{log+=String(data);});
  try{await new Promise<void>((done,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?done():reject(new Error(`Worker check exited ${code}: ${log.slice(-5000)}`)));});}finally{clearTimeout(timer);}
}
await launch('setup');
const conn=await connectDatabase('qs-agent-1');
const actions=()=>[...conn.db.myAction.iter()].filter(a=>a.runId===runId);
const inferences=()=>[...conn.db.myInference.iter()].filter(a=>a.runId===runId);
const run=()=>[...conn.db.myRun.iter()].find(r=>r.id===runId)!;
try{
  await launch('up');await new Promise(r=>setTimeout(r,100));
  assert.equal(actions().length,20);assert.ok(actions().every(a=>a.status==='completed'));
  assert.equal(inferences().length,20);assert.ok(inferences().every(i=>i.status==='completed'&&i.inputHash.length===64&&i.workId));
  const knowledge=[...conn.db.myKnowledge.iter()].filter(k=>k.runId===runId);
  assert.ok(knowledge.length>0,'Local observations must be shared');
  assert.ok(actions().some(a=>a.refs.split(',').some(id=>knowledge.some(k=>k.id===id&&!k.author.equals(a.actor)))),'Actions must cite another agent');
  const calls=run().usedCalls;const tokens=run().usedTokens;
  await launch('up');await new Promise(r=>setTimeout(r,100));
  assert.equal(actions().length,20,'A restart must not replay completed commands');
  assert.equal(run().usedCalls,calls);assert.equal(run().usedTokens,tokens);
  // Reproduce a crash between durable model output and action creation.
  const workId=recordId('game-action.',`${runId}.qs-agent-1.2`);
  const inferenceId=`recovery.${randomUUID()}`;
  await conn.reducers.beginInference({id:inferenceId,runId,reservedTokens:32000,model:'local-fixture',workId,inputHash:'a'.repeat(64)});
  await conn.reducers.finishInference({id:inferenceId,tokensUsed:100,outputJson:JSON.stringify({action:{kind:'wait',seconds:0},reason:'Recorded before worker restart',citations:[]})});
  const recoveryCalls=run().usedCalls;
  await launch('up',{GAME_AGENT_COUNT:'1',GAME_MAX_STEPS:'3'});await new Promise(r=>setTimeout(r,100));
  assert.equal(actions().find(a=>a.id===workId)?.status,'completed');
  assert.equal(run().usedCalls,recoveryCalls,'Recorded inference must be reused without a second call');
  console.log(`PASS ${runId}: ten independent workers, 20 completed actions/inferences, cross-agent citations, bounded concurrency, restart limits and recorded-output reuse`);
}finally{owner('set_run_status',[runId,'closed']);conn.disconnect();}
