import { randomUUID, createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createAsker, type Ask } from '../../src/agents/llm.ts';
import { connectDatabase } from './database.ts';
import { connectBot, execute, observe, stop } from './minecraft.ts';
import { Command, Decision, SYSTEM, type CommandValue } from './commands.ts';
import { recordId } from '../../src/ids.ts';

const name=process.env.GAME_AGENT_NAME??'qs-agent-1';
const runId=process.env.GAME_RUN_ID??'minecraft-pilot';
const brain=process.env.GAME_BRAIN??'rules';
if(!['rules','fixture','claude','codex'].includes(brain))throw new Error('GAME_BRAIN must be rules, fixture, claude or codex');
const maxSteps=Number(process.env.GAME_MAX_STEPS??100);
const stepMs=Number(process.env.GAME_STEP_MS??10000);
if(!Number.isInteger(maxSteps)||maxSteps<1||maxSteps>10000||!Number.isFinite(stepMs)||stepMs<1000)throw new Error('Invalid step limits');
const conn=await connectDatabase(name);
if(process.argv.includes('--register')){conn.disconnect();process.exit(0);}
let exiting=false;
const bot=await connectBot(name);
const authorityWatch=setInterval(()=>{
  const granted=[...conn.db.myMember.iter()].some(m=>m.runId===runId&&m.identity.equals(conn.identity!));
  if(!conn.isActive||!granted||[...conn.db.myRun.iter()].find(r=>r.id===runId)?.status!=='active')stop(bot);
},250);
const dir=resolve('.runs',runId,name);mkdirSync(dir,{recursive:true});
const trace=(data:unknown)=>appendFileSync(resolve(dir,'trace.jsonl'),JSON.stringify({at:new Date().toISOString(),...data as object})+'\n');
const shutdown=()=>{exiting=true;clearInterval(authorityWatch);stop(bot);bot.quit();conn.disconnect();};
process.on('SIGINT',shutdown);process.on('SIGTERM',shutdown);
bot.on('end',()=>{exiting=true;});
bot.on('death',()=>trace({incident:'death'}));
conn.db.myRun.onUpdate((_ctx,_old,row)=>{if(row.id===runId&&row.status!=='active')stop(bot);});
let ask:Ask|undefined;
if(brain==='fixture'){
  ask=async(schema,_system,prompt,options)=>{
    const latency=Number(process.env.GAME_FIXTURE_DELAY_MS??0);
    if(!Number.isInteger(latency)||latency<0||latency>10000)throw new Error('Invalid local fixture delay');
    if(latency)await new Promise(r=>setTimeout(r,latency));
    const input=JSON.parse(prompt);
    const other=input.knowledge.find((k:{author:string})=>k.author!==conn.identity!.toHexString());
    const tree=input.local.blocks.find((b:{name:string})=>b.name==='oak_log');
    options?.onUsage?.(100,'local-fixture');
    return schema.parse({action:!other&&tree?{kind:'share',label:'oak_log',position:{x:tree.position[0],y:tree.position[1],z:tree.position[2]}}:{kind:'wait',seconds:0},reason:'Schema-validated local response fixture',citations:other?[other.id]:[]});
  };ask.model='local-fixture';
}else if(brain!=='rules')ask=createAsker(brain==='claude'?'claude':'codex');
let shared=false;
function rules(state:ReturnType<typeof observe>):CommandValue {
  const logs=state.inventory.filter(i=>i.name.endsWith('_log')).reduce((n,i)=>n+i.count,0);
  const planks=state.inventory.filter(i=>i.name.endsWith('_planks')).reduce((n,i)=>n+i.count,0);
  if(state.inventory.some(i=>i.name==='crafting_table'))return {kind:'wait',seconds:2};
  const tree=state.blocks.find(b=>b.name==='oak_log');
  if(!shared&&tree&&[...conn.db.myRun.iter()].find(r=>r.id===runId)?.mode==='knowledge') {shared=true;return {kind:'share',label:tree.name,position:{x:tree.position[0],y:tree.position[1],z:tree.position[2]}};}
  if(process.env.GAME_RULES_TASK==='observe')return {kind:'wait',seconds:1};
  if(logs<5&&planks===0)return {kind:'collect',block:'oak_log',count:1};
  if(planks<4)return {kind:'craft',item:'oak_planks',count:1};
  return {kind:'craft',item:'crafting_table',count:1};
}
try {
  const unresolved=[...conn.db.myAction.iter()].filter(a=>a.runId===runId&&a.actor.equals(conn.identity!)&&['started','uncertain'].includes(a.status));
  for(const a of unresolved)if(a.status==='started')await conn.reducers.finishAction({id:a.id,status:'uncertain',result:'Worker restarted before result was recorded; inspect inventory/world before resuming'});
  if(unresolved.length)throw new Error('Uncertain prior action requires operator reconciliation; not replaying it');
  const completedSteps=[...conn.db.myAction.iter()].filter(a=>a.runId===runId&&a.actor.equals(conn.identity!)).length;
  for(let step=completedSteps;step<maxSteps&&!exiting;step++){
    if(!conn.isActive)throw new Error('Database disconnected; stopping actions');
    const run=[...conn.db.myRun.iter()].find(r=>r.id===runId);
    const membership=[...conn.db.myMember.iter()].find(m=>m.runId===runId&&m.identity.equals(conn.identity!));
    if(!run||!membership||run.status==='closed')break;
    if(run.status!=='active'){await new Promise(r=>setTimeout(r,1000));step--;continue;}
    const state=observe(bot);await conn.reducers.publishState({runId,stateJson:JSON.stringify(state)});
    const messages=run.mode==='none'?[]:[...conn.db.myMessage.iter()].filter(m=>m.runId===runId&&(!m.recipient||m.recipient===name)).slice(-30).map(m=>({id:m.id,author:m.sender.toHexString(),kind:m.kind,body:m.body,at:m.createdAt.toISOString()}));
    const knowledge=run.mode==='knowledge'?[...conn.db.myKnowledge.iter()].filter(k=>k.runId===runId).slice(-30).map(k=>({id:k.id,author:k.author.toHexString(),label:k.label,position:[k.x,k.y,k.z],state:k.state,at:k.updatedAt.toISOString()})):[];
    let command:CommandValue,citations:string[]=[],reason='deterministic acceptance';
    const actionId=recordId('game-action.',`${runId}.${name}.${step}`);
    if(ask){
      const prompt=JSON.stringify({goal:run.goal,self:name,local:state,messages,knowledge,lastActions:[...conn.db.myAction.iter()].filter(a=>a.actor.equals(conn.identity!)).slice(-3).map(a=>({command:a.commandJson,status:a.status,result:a.result}))});
      const reservedTokens=Buffer.byteLength(SYSTEM+prompt)+32000;
      const previous=[...conn.db.myInference.iter()].filter(i=>i.runId===runId&&i.workId===actionId&&i.actor.equals(conn.identity!));
      const recorded=previous.find(i=>i.status==='completed');
      if(previous.some(i=>i.status==='pending'))throw new Error('Uncertain prior inference must be reconciled before another model call');
      const inferenceId=recordId('game-inference.',`${actionId}.${previous.length}`);
      const inputHash=createHash('sha256').update(SYSTEM+prompt).digest('hex');
      if(!recorded){
        const current=[...conn.db.myRun.iter()].find(r=>r.id===runId)!;
        if(current.usedCalls>=current.maxCalls||current.usedTokens+reservedTokens>current.maxTokens)throw new Error('Shared inference budget exhausted');
        if([...conn.db.myInference.iter()].filter(i=>i.runId===runId&&i.status==='pending').length>=current.maxConcurrent){await new Promise(r=>setTimeout(r,500+Math.random()*500));step--;continue;}
        writeFileSync(resolve(dir,`${inferenceId}.input.json`),JSON.stringify({system:SYSTEM,prompt,inputHash}));
        try{await conn.reducers.beginInference({id:inferenceId,runId,reservedTokens,model:ask.model??'configured',workId:actionId,inputHash});}
        catch(error){
          // Competing workers may reserve the last slot after our snapshot check.
          if(String(error).includes('Inference budget or concurrency limit')){await new Promise(r=>setTimeout(r,500+Math.random()*500));step--;continue;}
          throw error;
        }
      }
      let tokensUsed=reservedTokens;
      const abort=new AbortController();
      const cancel=()=>{if(!conn.isActive||[...conn.db.myRun.iter()].find(r=>r.id===runId)?.status!=='active')abort.abort();};
      const watch=setInterval(cancel,250);
      try{
        const response=recorded?Decision.parse(JSON.parse(recorded.outputJson)):await ask(Decision,SYSTEM,prompt,{signal:abort.signal,onUsage:tokens=>{tokensUsed=tokens;}});
        if(!recorded)await conn.reducers.finishInference({id:inferenceId,tokensUsed,outputJson:JSON.stringify(response)});
        command=response.action;citations=response.citations;reason=response.reason;
      }finally{clearInterval(watch);}
    }else command=rules(state);
    Command.parse(command);
    const active=[...conn.db.myRun.iter()].find(r=>r.id===runId)?.status==='active';
    if(!active||!conn.isActive){step--;continue;}
    await conn.reducers.beginAction({id:actionId,runId,commandJson:JSON.stringify(command),refs:citations.join(',')});
    if([...conn.db.myAction.iter()].find(a=>a.id===actionId)?.status!=='started')throw new Error('Action already settled; refusing to replay it');
    let result:string,status='completed';
    try{
      if(command.kind==='post'){await conn.reducers.postMessage({id:`msg.${randomUUID()}`,runId,recipient:command.recipient,kind:command.messageKind,body:command.body});result='Message recorded';}
      else if(command.kind==='share'){await conn.reducers.publishKnowledge({id:`knowledge.${randomUUID()}`,runId,label:command.label,...command.position});result='Local observation shared';}
      else if(command.kind==='review'){await conn.reducers.reviewKnowledge({runId,id:command.id,state:command.state});result='Knowledge reviewed';}
      else result=await execute(bot,command);
    }catch(error){result=String(error).slice(0,3000);status=/timeout|disconnected/i.test(result)?'uncertain':'failed';}
    await conn.reducers.finishAction({id:actionId,status,result:result.slice(0,4000)});
    trace({step,actionId,state,command,citations,reason,status,result});console.log(`${name} ${step} ${command.kind}: ${status}`);
    if(status==='uncertain')throw new Error('Action outcome uncertain; stopped until operator reconciliation');
    await new Promise(r=>setTimeout(r,stepMs));
  }
}finally{shutdown();}
