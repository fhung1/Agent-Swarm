import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Timestamp } from 'spacetimedb';
import { DbConnection } from '../src/module_bindings/index.ts';
import { clientOrderIdFor, paperOrderIdFor } from '../src/agents/execution.ts';

const runId=`executor-check-${Date.now()}`;const accountId=`${runId}.paper`;
const cli=process.env.SPACETIME_CLI??'spacetime';const config=process.env.SPACETIME_CONFIG_PATH?['--config-path',process.env.SPACETIME_CONFIG_PATH]:[];
const server=process.env.SPACETIME_SERVER??'local';const db=process.env.SPACETIMEDB_DB_NAME??'quant-swarm';const host=process.env.SPACETIMEDB_HOST??'ws://127.0.0.1:3000';
const dir=mkdtempSync(join(tmpdir(),'executor-check-'));const stateFile=join(dir,'broker.json');const tokenFile=join(dir,'executor.token');
const clients:DbConnection[]=[];let child:ChildProcess|undefined;let log='';
function call(reducer:string,...args:(string|number)[]){execFileSync(cli,[...config,'call','--server',server,db,reducer,...args.map(a=>JSON.stringify(a))],{stdio:['ignore','pipe','pipe']});}
async function until(read:()=>boolean,label:string){const deadline=Date.now()+30000;while(!read()){if(Date.now()>deadline)throw new Error(`${label} timed out: ${log.slice(-5000)}`);await new Promise(r=>setTimeout(r,50));}}
async function connect(role:string){return await new Promise<{conn:DbConnection;token:string}>((done,reject)=>{
  DbConnection.builder().withUri(host).withDatabaseName(db).onConnect((conn,identity,token)=>{
    clients.push(conn);call('grant_agent',identity.toHexString(),role);call('grant_run_access',identity.toHexString(),runId);call('grant_account_access',identity.toHexString(),accountId);
    conn.subscriptionBuilder().onApplied(()=>done({conn,token})).onError(reject).subscribe(['SELECT * FROM my_paper_order','SELECT * FROM my_fill','SELECT * FROM my_paper_submission','SELECT * FROM my_account_check']);
  }).onConnectError((_ctx,error)=>reject(error)).build();
});}
function start(){child=spawn(process.execPath,['--import',resolve('scripts/mock-alpaca-fetch.mjs'),'dist/executor.js'],{env:{...process.env,AGENT_NAME:'mock-executor',AGENT_TOKEN_FILE:tokenFile,ALPACA_API_KEY:'fixture-key',ALPACA_API_SECRET:'fixture-secret',MOCK_ALPACA_STATE:stateFile,SPACETIMEDB_HOST:host,SPACETIMEDB_DB_NAME:db},stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout!,child.stderr!])stream.on('data',chunk=>{log+=String(chunk);});}
async function stop(){if(child&&child.exitCode===null&&child.signalCode===null){const exited=new Promise<void>(done=>child!.once('exit',()=>done()));child.kill('SIGKILL');await exited;}child=undefined;}
function broker(change:object={}){const state=JSON.parse(readFileSync(stateFile,'utf8'));writeFileSync(stateFile,JSON.stringify({...state,...change}));return {...state,...change};}
try{
  call('create_run',runId,'Mock broker execution only; never real orders');
  const {conn,token}=await connect('executor');writeFileSync(tokenFile,token,{mode:0o600});
  const coordinator=await connect('coordinator');const risk=await connect('risk');const ingestor=await connect('ingestor');
  const now=Timestamp.fromDate(new Date());
  const sourceId=`${runId}.source`,thesisId=`${runId}.thesis`,proposalId=`${runId}.proposal`,snapshotId=`${runId}.snapshot`,policyId=`${runId}.policy`;
  await ingestor.conn.reducers.addSource({id:sourceId,runId,symbol:'QMOCK',kind:'fixture',uri:'fixture://mock-broker',asOf:now,checksum:'fixture',artifactRef:''});
  await coordinator.conn.reducers.publishThesis({id:thesisId,runId,taskId:'',symbol:'QMOCK',bullCase:'Executor fixture',bearCase:'Synthetic',assumptions:'No real trading',invalidation:'End test',evidenceRefs:sourceId});
  await coordinator.conn.reducers.recordTradeDecision({decisionId:`${runId}.decision`,rationale:'Mock broker only',proposalId,runId,thesisId,symbol:'QMOCK',side:'buy',quantity:'2',orderType:'market',limitPrice:''});
  const policy={version:policyId,allowedSymbols:['QMOCK'],longOnly:true,maxOrderNotional:500,maxPositionNotional:1000,maxQuoteAgeMs:300000,maxAccountAgeMs:300000,maxLimitDeviation:0.03,approvalTtlMs:300000,maxProposalAgeMs:900000,requireMarketOpen:true};
  call('add_risk_policy',policyId,runId,accountId,JSON.stringify(policy));call('configure_run_limits',runId,10,100000,1,1);
  await risk.conn.reducers.recordAccountSnapshot({id:snapshotId,accountId,accountStatus:'ACTIVE',cash:'1000',buyingPower:'1000',equity:'1000',dailyPnl:'0',positionsJson:'[]',openOrdersJson:'[]',observations:[{id:`${snapshotId}.quote`,symbol:'QMOCK',feed:'iex',bidPrice:'99',askPrice:'100',bidSize:'10',askSize:'10',asOf:now}]});
  await risk.conn.reducers.recordMarketClock({accountId,isOpen:true,asOf:now});
  await risk.conn.reducers.recordRiskDecision({id:`${runId}.risk`,proposalId,policyVersion:policyId,outcome:'pass',checks:'fixture',expiresAt:Timestamp.fromDate(new Date(Date.now()+300000)),snapshotId,clockAsOf:now});
  writeFileSync(stateFile,JSON.stringify({accountId,posts:0,filled:0}));start();
  await until(()=>[...conn.db.myPaperSubmission.iter()].some(a=>a.status==='uncertain'),'accepted-before-timeout audit');
  await stop();assert.equal(broker().posts,1);
  start();
  const orderId=paperOrderIdFor(proposalId);
  await until(()=>conn.db.myPaperOrder.id.find(orderId)?.status==='partially_filled','restart partial fill recovery');
  assert.equal(broker().posts,1,'Restart must look up accepted order, not resubmit');
  assert.equal(conn.db.myPaperOrder.id.find(orderId)?.clientOrderId,clientOrderIdFor(proposalId));
  assert.equal([...conn.db.myFill.iter()].filter(f=>f.orderId===orderId).length,1);
  broker({filled:2});await until(()=>conn.db.myPaperOrder.id.find(orderId)?.status==='filled','final fill recovery');
  assert.equal([...conn.db.myFill.iter()].filter(f=>f.orderId===orderId).length,2);
  broker({cashDrift:-50});await until(()=>conn.db.myAccountCheck.accountId.find(accountId)?.status==='mismatch','external cash mismatch');
  assert.match(conn.db.myAccountCheck.accountId.find(accountId)!.details,/Cash differs/);
  broker({cashDrift:0,externalOrder:true});await until(()=>conn.db.myAccountCheck.accountId.find(accountId)?.details.includes('Untracked broker order')??false,'external order mismatch');
  broker({externalOrder:false});await until(()=>conn.db.myAccountCheck.accountId.find(accountId)?.status==='matched','reconciliation recovery');
  assert.equal(broker().posts,1);assert.equal([...conn.db.myPaperSubmission.iter()].length,1);
  console.log(`PASS ${runId}: real executor process, accepted-before-timeout crash/restart, one broker request, partial/full fill reconciliation, cash/external-order interlocks and recovery`);
}finally{await stop();for(const conn of clients)conn.disconnect();try{call('set_run_status',runId,'closed');}catch{}rmSync(dir,{recursive:true,force:true});}
