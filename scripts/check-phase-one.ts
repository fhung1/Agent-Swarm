import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Timestamp } from 'spacetimedb';
import { DbConnection } from '../src/module_bindings/index.ts';
import { recordId } from '../src/ids.ts';

// Real local reducers and worker processes; synthetic evidence, no provider or broker calls.
const cli = process.env.SPACETIME_CLI ?? 'spacetime';
const cliConfig = process.env.SPACETIME_CONFIG_PATH ? ['--config-path', process.env.SPACETIME_CONFIG_PATH] : [];
const server = process.env.SPACETIME_SERVER ?? 'local';
const host = process.env.SPACETIMEDB_HOST ?? 'ws://localhost:3000';
const database = process.env.SPACETIMEDB_DB_NAME ?? 'quant-swarm';
const runId = `phase-one-${Date.now()}`;
const otherRun = `${runId}.other`;
const accountId = `${runId}.paper`;
const dir = mkdtempSync(join(tmpdir(), 'quant-phase-one-'));
const clients: any[] = [];
const workers: ChildProcess[] = [];
const logs = new Map<ChildProcess, string>();
const call = (...args: string[]) => execFileSync(cli, [...cliConfig, 'call', '--server', server, database, ...args], { encoding: 'utf8', stdio: ['ignore','pipe','pipe'] });
const tables = ['agent','run','task','message','source','fact','thesis','decision','trade_proposal','account_snapshot','market_observation','risk_decision','risk_decision_history','paper_order','order_cancel_request','fill','run_config','risk_policy','market_clock','risk_reservation','decision_input','inference_attempt'];
const now = () => Timestamp.fromDate(new Date());
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn: () => unknown, label: string, timeout = 20000) {
  const end = Date.now() + timeout;
  while (!fn()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await delay(30); }
}
async function connect(role?: string, token?: string): Promise<any> {
  return new Promise((resolve,reject) => {
    const timer = setTimeout(() => reject(new Error('Connection timeout')),15000);
    DbConnection.builder().withUri(host).withDatabaseName(database).withToken(token)
      .onConnect((conn, identity, savedToken) => {
        clients.push(conn);
        if (role) call('grant_agent',identity.toHexString(),role);
        conn.subscriptionBuilder().onApplied(() => { clearTimeout(timer); resolve({ conn, identity, token:savedToken }); })
          .onError(ctx => { clearTimeout(timer); reject(ctx); }).subscribe(tables.map(t => `SELECT * FROM my_${t}`));
      }).onConnectError((_ctx,error) => {clearTimeout(timer);reject(error);}).build();
  });
}
function grant(client: any, run = runId) { call('grant_run_access',client.identity.toHexString(),run); }
function grantAccount(client: any, account = accountId) { call('grant_account_access',client.identity.toHexString(),account); }
function start(client: any, name: string, workDelay = 0, workerRun = runId) {
  const file = join(dir,`${name}.token`); writeFileSync(file, client.token, {mode:0o600});
  const child = spawn(process.execPath,['dist/worker.js'], { env: { ...process.env, AGENT_NAME:name, RUN_ID:workerRun,
    AUTO_CLAIM:'1', AGENT_BRAIN:'rules', AGENT_TOKEN_FILE:file, WORK_DELAY_MS:String(workDelay), SPACETIMEDB_DB_NAME:database, SPACETIMEDB_HOST:host }, stdio:['ignore','pipe','pipe'] });
  workers.push(child); logs.set(child,'');
  for (const stream of [child.stdout,child.stderr]) stream!.on('data',chunk => logs.set(child, logs.get(child)! + String(chunk)));
  return child;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>(resolve => child.once('exit',()=>resolve()));
  child.kill('SIGKILL'); await exited;
}
let created = false;
try {
  const op = await connect('operator');
  await op.conn.reducers.createRun({id:runId,goal:'Phase 1 synthetic acceptance; no brokerage calls'});
  created = true;
  await op.conn.reducers.createRun({id:otherRun,goal:'Isolation sentinel'});
  const ingestor = await connect('ingestor'); grant(ingestor);
  const a = await connect('analyst'); grant(a);
  const b = await connect('analyst'); grant(b);
  const skeptic = await connect('skeptic'); grant(skeptic);
  const coordinator = await connect('coordinator'); grant(coordinator);
  const market = await connect('market_data'); grantAccount(market);
  const risk = await connect('risk'); grant(risk); grantAccount(risk);
  const executor = await connect('executor'); grant(executor); grantAccount(executor);
  grantAccount(op);
  const stranger = await connect();
  assert.equal([...stranger.conn.db.myRun.iter()].length,0);
  assert.equal([...stranger.conn.db.myAgent.iter()].length,0);
  await assert.rejects(new Promise<void>((resolve,reject) => stranger.conn.subscriptionBuilder()
    .onApplied(() => resolve()).onError(() => reject(new Error('private table denied'))).subscribe('SELECT * FROM task')),/private table denied/);
  console.log('PASS ungranted identities have empty views; private table subscription denied');
  await op.conn.reducers.createTask({id:`${otherRun}.sentinel`,runId:otherRun,symbol:'QOTHER',kind:'research',objective:'Must remain invisible',role:'analyst',dependsOn:''});
  await waitFor(()=>a.conn.db.myRun.id.find(runId),'authorized run');
  assert.equal(a.conn.db.myRun.id.find(otherRun),null);
  assert.equal(a.conn.db.myTask.id.find(`${otherRun}.sentinel`),null);
  await assert.rejects(a.conn.reducers.claimTask({id:`${otherRun}.sentinel`,expectedVersion:0n}),/Run access required/);
  call('revoke_run_access',b.identity.toHexString(),runId);
  await waitFor(()=>!b.conn.db.myRun.id.find(runId),'live membership eviction'); grant(b);
  console.log('PASS run isolation and live grant/revoke cache updates');
  const sourceId = `${runId}.source`;
  await ingestor.conn.reducers.addSource({id:sourceId,runId,symbol:'QPHASE',kind:'fixture',uri:'fixture://phase-one',asOf:now(),checksum:'synthetic',artifactRef:''});
  await ingestor.conn.reducers.addFact({id:`${runId}.fact`,sourceId,symbol:'QPHASE',metric:'revenue',value:'100',unit:'USD',period:'fixture',quality:'fixture'});
  const makeTask = (id: string) => op.conn.reducers.createTask({id,runId,symbol:'QPHASE',kind:'thesis',objective:'Synthetic coordination check',role:'analyst',dependsOn:''});
  const raceId = `${runId}.race`;
  const wa = start(a,'phase-analyst-a',10000), wb = start(b,'phase-analyst-b',10000);
  const wc = start(coordinator,'phase-coordinator'), ws = start(skeptic,'phase-skeptic');
  await waitFor(()=>logs.get(wa)?.includes('Subscription ready') && logs.get(wb)?.includes('Subscription ready'),'worker snapshots');
  await makeTask(raceId);
  await waitFor(()=>op.conn.db.myTask.id.find(raceId)?.status==='claimed','atomic claim');
  const claimed = op.conn.db.myTask.id.find(raceId)!;
  const winner = claimed.assignee.equals(a.identity) ? a : b;
  const loser = winner === a ? b : a;
  await delay(300);
  assert.equal([wa,wb].filter(w=>logs.get(w)?.includes(`Claimed ${raceId}`)).length,1);
  await stop(wa); await stop(wb);
  const restarted = start(winner,'phase-restarted');
  await waitFor(()=>op.conn.db.myTask.id.find(raceId)?.status==='completed','restart completes original claim');
  assert.ok(op.conn.db.myTask.id.find(raceId)!.assignee.equals(winner.identity));
  await waitFor(()=>[...op.conn.db.myDecision.iter()].some((d:any)=>d.thesisId===recordId('thesis.',raceId)),'three-worker sourced decision');
  assert.ok(logs.get(restarted)?.includes(`Resuming ${raceId}`));
  assert.equal([...op.conn.db.myThesis.iter()].filter((t:any)=>t.taskId===raceId).length,1);
  console.log('PASS two-process claim race; same-token restart; analyst/skeptic/coordinator sourced decision');
  await stop(restarted);
  const pausedId = `${runId}.pause`;
  const pausedWorker = start(winner,'phase-paused',2500);
  await makeTask(pausedId);
  await waitFor(()=>op.conn.db.myTask.id.find(pausedId)?.status==='claimed','pause task claim');
  await op.conn.reducers.setRunStatus({id:runId,status:'paused'});
  await delay(3000);
  assert.equal(op.conn.db.myTask.id.find(pausedId)?.status,'claimed');
  assert.equal(op.conn.db.myThesis.id.find(recordId('thesis.',pausedId)),null);
  await op.conn.reducers.setRunStatus({id:runId,status:'active'});
  await waitFor(()=>op.conn.db.myTask.id.find(pausedId)?.status==='completed','resume completes task',25000);
  await stop(pausedWorker);
  console.log('PASS pause defers work without failure; resume completes held task');
  const takeoverId = `${runId}.takeover`;
  await makeTask(takeoverId);
  await waitFor(()=>winner.conn.db.myTask.id.find(takeoverId),'takeover task snapshot');
  await winner.conn.reducers.claimTask({id:takeoverId,expectedVersion:0n});
  const thesisId = recordId('thesis.',takeoverId);
  await winner.conn.reducers.publishThesis({id:thesisId,runId,taskId:takeoverId,symbol:'QPHASE',bullCase:'Synthetic saved result',bearCase:'No investment claim',assumptions:'Fixture only',invalidation:'Real evidence replaces fixture',evidenceRefs:sourceId});
  await winner.conn.reducers.postMessage({id:recordId('',thesisId,'.claim'),runId,taskId:takeoverId,symbol:'QPHASE',recipientRole:'coordinator',kind:'claim',body:'Saved before worker interruption',evidenceRef:thesisId});
  const takeoverWorker = start(loser,'phase-takeover');
  const longId = `${runId}.` + 'x'.repeat(128-runId.length-1);
  await makeTask(longId);
  await waitFor(()=>op.conn.db.myTask.id.find(longId)?.status==='completed','maximum-length task IDs');
  console.log('PASS 128-character task ID produces valid stable derived records');
  // Exercise durable accounting while the abandoned lease is expiring.
  await op.conn.reducers.configureRunLimits({runId,maxInferences:2,maxTokens:40000,maxConcurrent:1,maxAttempts:2});
  const budgetTask = `${runId}.budget`;
  // A different kind avoids worker auto-claim while reducers still exercise task ownership.
  await op.conn.reducers.createTask({id:budgetTask,runId,symbol:'QPHASE',kind:'research',objective:'Durable budget checks',role:'analyst',dependsOn:''});
  await waitFor(()=>winner.conn.db.myTask.id.find(budgetTask),'budget task');
  await winner.conn.reducers.claimTask({id:budgetTask,expectedVersion:0n});
  const inference = {id:`${runId}.inference`,runId,workId:budgetTask,model:'fixture',promptVersion:'test-v1',inputRefs:sourceId,reservedTokens:20000};
  await winner.conn.reducers.beginInference(inference);
  await assert.rejects(winner.conn.reducers.beginInference({...inference,id:`${runId}.busy`}),/capacity busy/);
  await winner.conn.reducers.finishInference({id:inference.id,tokensUsed:100,succeeded:true,model:'fixture-actual',outputJson:'{"saved":true}'});
  await winner.conn.reducers.beginInference({...inference,id:`${runId}.retry`});
  await winner.conn.reducers.finishInference({id:`${runId}.retry`,tokensUsed:0,succeeded:false,model:'fixture',outputJson:''});
  await assert.rejects(winner.conn.reducers.beginInference({...inference,id:`${runId}.exhausted`}),/attempts exhausted/);
  await waitFor(()=>winner.conn.db.myInferenceAttempt.id.find(inference.id)?.status==='completed','durable inference audit');
  assert.equal(winner.conn.db.myInferenceAttempt.id.find(inference.id)?.actualModel,'fixture-actual');
  assert.equal(winner.conn.db.myRunConfig.runId.find(runId)?.usedTokens,20100);
  console.log('PASS inference concurrency, attempts, conservative failed-call accounting and output audit');
  // Risk/ledger check uses only the local simulated ledger, never sends a paper order.
  const policyId = `${runId}.policy`;
  const policy = {version:policyId,allowedSymbols:['QPHASE','QSECOND'],longOnly:true,maxOrderNotional:1000,maxPositionNotional:5000,maxQuoteAgeMs:120000,maxAccountAgeMs:120000,maxLimitDeviation:0.05,approvalTtlMs:120000,maxProposalAgeMs:900000,requireMarketOpen:true,maxPortfolioNotional:10000,maxOpenOrders:5};
  await op.conn.reducers.addRiskPolicy({id:policyId,runId,accountId,policyJson:JSON.stringify(policy)});
  const snapshot = async (suffix: string, malformed = false) => {
    const id = `${runId}.account.${suffix}`;
    await risk.conn.reducers.recordAccountSnapshot({id,accountId,accountStatus:'ACTIVE',cash:'250',buyingPower:'250',equity:'10000',positionsJson:malformed?'[{"symbol":"QPHASE","qty":"bad","market_value":"bad"}]':'[]',openOrdersJson:'[]',observations:['QPHASE','QSECOND'].map(symbol=>({id:`${id}.${symbol}`,symbol,feed:'iex',bidPrice:'99',askPrice:'100',bidSize:'1',askSize:'1',asOf:now()}))});
    return id;
  };
  await assert.rejects(snapshot('bad',true));
  const snapshotId = await snapshot('one'); const clockAsOf = now();
  await risk.conn.reducers.recordMarketClock({accountId,isOpen:true,asOf:clockAsOf});
  await waitFor(()=>risk.conn.db.myAccountSnapshot.id.find(snapshotId),'risk account access');
  assert.equal(a.conn.db.myAccountSnapshot.id.find(snapshotId),null);
  const riskTask = `${runId}.risk-task`;
  const riskThesis = `${runId}.risk-thesis`;
  await op.conn.reducers.createTask({id:riskTask,runId,symbol:'QPHASE',kind:'research',objective:'Local ledger checks',role:'analyst',dependsOn:''});
  await waitFor(()=>winner.conn.db.myTask.id.find(riskTask),'risk task');
  await winner.conn.reducers.claimTask({id:riskTask,expectedVersion:0n});
  await winner.conn.reducers.publishThesis({id:riskThesis,runId,taskId:riskTask,symbol:'QPHASE',bullCase:'Synthetic ledger check',bearCase:'No trading evidence',assumptions:'Fixture',invalidation:'Real data',evidenceRefs:sourceId});
  await winner.conn.reducers.completeTask({id:riskTask,result:riskThesis});
  await coordinator.conn.reducers.recordDecision({id:`${runId}.risk-trade`,thesisId:riskThesis,outcome:'trade',rationale:'Local ledger acceptance only; no broker submission'});
  const propose = async (suffix: string,symbol: string) => {
    const id = `${runId}.proposal.${suffix}`;
    // A symbol-specific thesis is required; use the existing QPHASE thesis for these orders.
    await coordinator.conn.reducers.proposeTrade({id,runId,thesisId:riskThesis,symbol,side:'buy',quantity:'2',orderType:'market',limitPrice:''}); return id;
  };
  const proposalId = await propose('first','QPHASE');
  let verdict = {id:`${runId}.risk.first`,proposalId,policyVersion:policyId,outcome:'pass',checks:'untrusted supplied checks',expiresAt:Timestamp.fromDate(new Date(Date.now()+90000)),snapshotId,clockAsOf};
  await assert.rejects(risk.conn.reducers.recordRiskDecision({...verdict,outcome:'reject'}),/authoritative evaluation/);
  await risk.conn.reducers.recordRiskDecision(verdict);
  const orderId = `${runId}.order`;
  const newSnapshot = await snapshot('two');
  await assert.rejects(executor.conn.reducers.reservePaperOrder({id:orderId,proposalId,clientOrderId:`${runId}.client`}),/Risk inputs changed/);
  verdict = {...verdict,id:`${runId}.risk.refresh`,snapshotId:newSnapshot};
  await risk.conn.reducers.recordRiskDecision(verdict);
  await waitFor(()=>risk.conn.db.myRiskDecisionHistory.id.find(`${runId}.risk.first`),'archived risk review');
  await executor.conn.reducers.reservePaperOrder({id:orderId,proposalId,clientOrderId:`${runId}.client`});
  await executor.conn.reducers.reservePaperOrder({id:orderId,proposalId,clientOrderId:`${runId}.client`});
  const unrelatedExecutor = await connect('executor'); grant(unrelatedExecutor);
  await assert.rejects(unrelatedExecutor.conn.reducers.reservePaperOrder({id:orderId,proposalId,clientOrderId:`${runId}.client`}),/Account access required/);
  await assert.rejects(executor.conn.reducers.updatePaperOrder({id:orderId,alpacaOrderId:'fixture-broker',status:'filled'}),/reconciled fills/);
  await executor.conn.reducers.updatePaperOrder({id:orderId,alpacaOrderId:'fixture-broker',status:'accepted'});
  await assert.rejects(executor.conn.reducers.updatePaperOrder({id:orderId,alpacaOrderId:'',status:'rejected'}),/Alpaca order ID|identity cannot change/);
  await assert.rejects(executor.conn.reducers.updatePaperOrder({id:orderId,alpacaOrderId:'different-broker',status:'accepted'}),/identity cannot change/);
  const fill = {id:`${runId}.fill`,orderId,alpacaActivityId:`${runId}.activity`,quantity:'1',price:'100',filledAt:now()};
  await executor.conn.reducers.recordFill(fill); await executor.conn.reducers.recordFill(fill);
  await assert.rejects(executor.conn.reducers.recordFill({...fill,id:`${runId}.overfill`,alpacaActivityId:`${runId}.overfill`,quantity:'2',filledAt:now()}),/Cumulative fills/);
  await executor.conn.reducers.updatePaperOrder({id:orderId,alpacaOrderId:'fixture-broker',status:'partially_filled'});
  await assert.rejects(executor.conn.reducers.updatePaperOrder({id:orderId,alpacaOrderId:'fixture-broker',status:'accepted'}),/Invalid order transition/);
  // A new proposal for the same symbol is rejected while the first reservation is outstanding.
  const duplicate = await propose('duplicate','QPHASE');
  await assert.rejects(risk.conn.reducers.recordRiskDecision({...verdict,id:`${runId}.risk.dup`,proposalId:duplicate}),/authoritative evaluation/);
  await risk.conn.reducers.recordRiskDecision({...verdict,id:`${runId}.risk.dup`,proposalId:duplicate,outcome:'reject'});
  await assert.rejects(stranger.conn.reducers.requestOrderCancel({orderId,reason:'unauthorized'}),/Role not authorized/);
  await op.conn.reducers.requestOrderCancel({orderId,reason:'Phase-one cancellation race check'});
  await waitFor(()=>op.conn.db.myOrderCancelRequest.orderId.find(orderId)?.status==='requested','operator cancellation request');
  assert.equal(op.conn.db.myPaperOrder.id.find(orderId)?.status,'partially_filled');
  await executor.conn.reducers.updateOrderCancel({orderId,status:'broker_requested',detail:'Fixture broker accepted request'});
  await assert.rejects(executor.conn.reducers.updateOrderCancel({orderId,status:'resolved',detail:'too early'}),/terminal order/);
  await executor.conn.reducers.updatePaperOrder({id:orderId,alpacaOrderId:'fixture-broker',status:'canceled'});
  await executor.conn.reducers.updateOrderCancel({orderId,status:'resolved',detail:'Broker order reached terminal state canceled'});
  await waitFor(()=>op.conn.db.myOrderCancelRequest.orderId.find(orderId)?.status==='resolved','resolved cancellation audit');
  console.log('PASS authoritative risk, ledger validation, durable cancellation request and partial-fill cancellation race');
  // A refused request before broker order creation has no ID, but is still terminal.
  const refusedProposal = await propose('refused','QPHASE');
  await risk.conn.reducers.recordRiskDecision({...verdict,id:`${runId}.risk.refused`,proposalId:refusedProposal});
  const refusedOrder = `${runId}.order.refused`;
  await executor.conn.reducers.reservePaperOrder({id:refusedOrder,proposalId:refusedProposal,clientOrderId:`${runId}.client.refused`});
  await assert.rejects(executor.conn.reducers.updatePaperOrder({id:refusedOrder,alpacaOrderId:'',status:'new'}),/Alpaca order ID/);
  await executor.conn.reducers.updatePaperOrder({id:refusedOrder,alpacaOrderId:'',status:'rejected'});
  await waitFor(()=>executor.conn.db.myPaperOrder.id.find(refusedOrder)?.status==='rejected','refused order terminal state');
  assert.equal(executor.conn.db.myPaperOrder.id.find(refusedOrder)?.alpacaOrderId,'');
  const afterRefusal = await propose('after-refusal','QPHASE');
  await risk.conn.reducers.recordRiskDecision({...verdict,id:`${runId}.risk.after-refusal`,proposalId:afterRefusal});
  await waitFor(()=>risk.conn.db.myRiskDecision.id.find(`${runId}.risk.after-refusal`),'exposure released after refusal');
  assert.equal(risk.conn.db.myRiskDecision.id.find(`${runId}.risk.after-refusal`)?.outcome,'pass');
  console.log('PASS pre-creation refusal releases exposure; nonterminal states require IDs; existing broker IDs cannot be cleared');
  call('revoke_account_access',risk.identity.toHexString(),accountId);
  await waitFor(()=>!risk.conn.db.myAccountSnapshot.id.find(snapshotId),'account revocation');
  await assert.rejects(risk.conn.reducers.recordMarketClock({accountId,isOpen:true,asOf:now()}),/Account access required/);
  console.log('PASS pending reservation rejection and live account access revocation');
  const renewalClient = await connect('analyst'); grant(renewalClient,otherRun);
  grant(ingestor,otherRun);
  await ingestor.conn.reducers.addSource({id:`${otherRun}.source`,runId:otherRun,symbol:'QPHASE',kind:'fixture',uri:'fixture://lease-renewal',asOf:now(),checksum:'synthetic',artifactRef:''});
  const renewalId = `${runId}.renewal`;
  await stop(takeoverWorker);
  await op.conn.reducers.createTask({id:renewalId,runId:otherRun,symbol:'QPHASE',kind:'thesis',objective:'Slow lease renewal',role:'analyst',dependsOn:''});
  await waitFor(()=>renewalClient.conn.db.myTask.id.find(renewalId),'renewal task');
  // Keep the takeover process from claiming this task before the slow worker starts.
  const renewalTask = renewalClient.conn.db.myTask.id.find(renewalId)!;
  if (renewalTask.status === 'open') await renewalClient.conn.reducers.claimTask({id:renewalId,expectedVersion:renewalTask.version});
  else throw new Error('Renewal test task claimed before test setup');
  const slowWorker = start(renewalClient,'phase-renewal',65000,otherRun);
  const replacement = start(loser,'phase-takeover-final');
  await waitFor(()=>op.conn.db.myTask.id.find(takeoverId)?.status==='completed','expired lease takeover',75000);
  assert.ok(op.conn.db.myTask.id.find(takeoverId)!.assignee.equals(loser.identity));
  assert.ok(op.conn.db.myMessage.id.find(recordId('',thesisId,'.claim'))!.sender.equals(winner.identity));
  assert.equal([...op.conn.db.myThesis.iter()].filter((t:any)=>t.taskId===takeoverId).length,1);
  await waitFor(()=>op.conn.db.myTask.id.find(renewalId)?.status==='completed','long work lease renewals',75000);
  assert.ok((logs.get(slowWorker)?.match(/Renewed lease on/g) ?? []).length >= 3);
  await stop(slowWorker); await stop(replacement); await stop(wc); await stop(ws);
  console.log('PASS expired-lease takeover preserves prior thesis and message authorship');
  console.log('PASS 65-second task completes through lease renewal');
  console.log(`PASS Phase 1 acceptance: ${runId}; no model or broker API calls`);
} catch (error) {
  for (const [child,output] of logs) console.error(`Worker pid ${child.pid}:\n${output.slice(-1500)}`);
  throw error;
} finally {
  await Promise.all(workers.map(stop));
  if (created) { call('set_run_status',runId,'closed'); call('set_run_status',otherRun,'closed'); }
  for (const conn of clients) conn.disconnect();
  for (const identity of new Set(clients.map(c=>c.identity.toHexString()))) call('revoke_agent',identity);
  rmSync(dir,{recursive:true,force:true});
}
