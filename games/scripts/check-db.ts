import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { connectDatabase, DATABASE } from '../src/database.ts';
const cli=process.env.SPACETIME_CLI??'spacetime';
const runId=`game-check-${Date.now()}`;
function call(reducer:string,args:(string|number)[]){execFileSync(cli,['call','--server','local',DATABASE,reducer,...args.map(a=>JSON.stringify(a))],{stdio:['ignore','pipe','pipe']});}
async function visible(read:()=>boolean){const deadline=Date.now()+5000;while(!read()){if(Date.now()>deadline)throw new Error('Subscription update did not arrive');await new Promise(r=>setTimeout(r,50));}}
const a=await connectDatabase('db-check-a');const b=await connectDatabase('db-check-b');const outsider=await connectDatabase('db-check-outsider');
try{
  assert.equal([...outsider.db.myRun.iter()].length,0);
  call('create_run',[runId,'Database authorization and coordination check','knowledge',2,100000,1]);
  call('grant_member',[runId,a.identity!.toHexString(),'db-check-a']);call('grant_member',[runId,b.identity!.toHexString(),'db-check-b']);
  await visible(()=>[...a.db.myRun.iter()].some(r=>r.id===runId)&&[...b.db.myRun.iter()].some(r=>r.id===runId));
  const stateJson=JSON.stringify({position:[0,70,0],inventory:[]});
  await a.reducers.publishState({runId,stateJson});await b.reducers.publishState({runId,stateJson});
  const messageId=`msg.${randomUUID()}`;
  await a.reducers.postMessage({id:messageId,runId,recipient:'db-check-b',kind:'observation',body:'Oak at x=1,y=70,z=0'});
  await visible(()=>[...b.db.myMessage.iter()].some(m=>m.id===messageId));
  await assert.rejects(b.reducers.postMessage({id:messageId,runId,recipient:'db-check-b',kind:'observation',body:'Oak at x=1,y=70,z=0'}));
  await assert.rejects(outsider.reducers.publishState({runId,stateJson}));
  await assert.rejects(b.reducers.grantMember({runId,identity:outsider.identity!,name:'intruder'}));
  const knowledgeId=`know.${randomUUID()}`;
  await a.reducers.publishKnowledge({id:knowledgeId,runId,label:'oak_log',x:1,y:70,z:0});
  await visible(()=>[...b.db.myKnowledge.iter()].some(k=>k.id===knowledgeId));
  await b.reducers.reviewKnowledge({runId,id:knowledgeId,state:'confirmed'});
  await assert.rejects(a.reducers.publishKnowledge({id:`far.${randomUUID()}`,runId,label:'oak_log',x:100,y:70,z:0}));
  const actionId=`action.${randomUUID()}`;
  const args={id:actionId,runId,commandJson:JSON.stringify({kind:'collect',block:'oak_log',count:1}),refs:knowledgeId};
  await b.reducers.beginAction(args);await b.reducers.beginAction(args);
  await assert.rejects(b.reducers.beginAction({...args,id:`action.${randomUUID()}`}));
  await b.reducers.finishAction({id:actionId,status:'completed',result:'One oak log collected'});
  await visible(()=>[...a.db.myAction.iter()].some(r=>r.id===actionId&&r.status==='completed'));
  await assert.rejects(a.reducers.postMessage({id:`big.${randomUUID()}`,runId,recipient:'',kind:'observation',body:'x'.repeat(2001)}));
  const inferenceId=`model.${randomUUID()}`;
  const inputHash='a'.repeat(64);
  await a.reducers.beginInference({id:inferenceId,runId,reservedTokens:32000,model:'fixture',workId:actionId,inputHash});
  await assert.rejects(b.reducers.beginInference({id:`model.${randomUUID()}`,runId,reservedTokens:32000,model:'fixture',workId:actionId,inputHash}));
  await a.reducers.finishInference({id:inferenceId,tokensUsed:100,outputJson:'{}'});
  await assert.rejects(a.reducers.beginInference({id:`model.${randomUUID()}`,runId,reservedTokens:32000,model:'fixture',workId:actionId,inputHash}));
  await b.reducers.beginInference({id:`model.${randomUUID()}`,runId,reservedTokens:32000,model:'fixture',workId:actionId,inputHash});
  await assert.rejects(a.reducers.beginInference({id:`model.${randomUUID()}`,runId,reservedTokens:32000,model:'fixture',workId:actionId,inputHash}));
  call('set_run_status',[runId,'paused']);
  await assert.rejects(a.reducers.beginAction({id:`action.${randomUUID()}`,runId,commandJson:'{}',refs:''}));
  call('revoke_member',[runId,b.identity!.toHexString()]);
  await visible(()=>![...b.db.myRun.iter()].some(r=>r.id===runId)&&![...b.db.myMessage.iter()].some(r=>r.runId===runId));
  console.log(`PASS ${runId}: two-identity delivery/citations, authorship/owner/payload/radius checks, idempotence, concurrency/budgets, pause and live read revocation`);
}finally{
  call('set_run_status',[runId,'closed']);call('revoke_member',[runId,a.identity!.toHexString()]);call('revoke_member',[runId,b.identity!.toHexString()]);
  a.disconnect();b.disconnect();outsider.disconnect();
}
