import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Timestamp } from 'spacetimedb';
import { DbConnection } from '../src/module_bindings/index.ts';
import { modelWriteThesis, modelReviewThesis, modelDecide } from '../src/agents/model-handlers.ts';

// Requires a running local database and its publisher's CLI login. Uses synthetic QFIX evidence.
// No model credentials or broker API calls are needed; temporary roles are revoked after the check.
const cli = process.env.SPACETIME_CLI ?? 'spacetime';
const cliConfig = process.env.SPACETIME_CONFIG_PATH ? ['--config-path', process.env.SPACETIME_CONFIG_PATH] : [];
const server = process.env.SPACETIME_SERVER ?? 'local';
const host = process.env.SPACETIMEDB_HOST ?? 'ws://localhost:3000';
const database = process.env.SPACETIMEDB_DB_NAME ?? 'quant-swarm';
let runCreated = false;
const runId = `model-fixture-${Date.now()}`;
const clients: any[] = [];
const call = (...args: string[]) => execFileSync(cli, [...cliConfig, 'call', '--server', server, database, ...args], {encoding:'utf8'});
async function connect(role: string, token?: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('connection timeout')), 15000);
    DbConnection.builder().withUri(host).withDatabaseName(database).withToken(token)
      .onConnect((conn, identity, savedToken) => {
        clients.push(conn);
        call('grant_agent', identity.toHexString(), role);
        if (runCreated) call('grant_run_access',identity.toHexString(),runId);
        conn.subscriptionBuilder().onApplied(() => {
          clearTimeout(timeout); resolve({conn, token: savedToken});
        }).onError(reject).subscribe(['SELECT * FROM my_agent', 'SELECT * FROM my_run', 'SELECT * FROM my_task',
          'SELECT * FROM my_message', 'SELECT * FROM my_source', 'SELECT * FROM my_fact', 'SELECT * FROM my_thesis',
          'SELECT * FROM my_decision', 'SELECT * FROM my_decision_input', 'SELECT * FROM my_run_config', 'SELECT * FROM my_inference_attempt', 'SELECT * FROM my_trade_proposal', 'SELECT * FROM my_market_observation']);
      }).onConnectError((_ctx, error) => {clearTimeout(timeout); reject(error)}).build();
  });
}
async function waitFor(fn: () => unknown): Promise<void> {
  const deadline=Date.now()+10000;
  while (!fn()) { if(Date.now()>deadline) throw new Error('cache convergence timeout'); await new Promise(r=>setTimeout(r,20)); }
}
let calls=0;
const ask = (output: unknown) => async (schema: any, _system: string, _prompt: string, options?: any) => {
  calls++;
  options?.onUsage?.({inputTokens:100,cacheReadTokens:0,cacheWriteTokens:0,outputTokens:100},'fixture');
  return schema.parse(output);
};
const neverAsk = async () => {throw new Error('stored result must not call model again')};
try {
  const operator = (await connect('operator')).conn;
  const ingestor = (await connect('ingestor')).conn;
  const reader = (await connect('market_data')).conn;
  const analyst = (await connect('analyst')).conn;
  const skeptic = (await connect('skeptic')).conn;
  let coordinatorClient = await connect('coordinator');
  let coordinator = coordinatorClient.conn;
  await operator.reducers.createRun({id:runId,goal:'Fixture model-handler verification; synthetic evidence only'});
  await operator.reducers.configureRunLimits({runId,maxInferences:30,maxTokens:1_000_000,maxConcurrent:3,maxAttempts:3});
  await operator.reducers.configureModelPrice({version:'research-fixture-v1',model:'fixture',
    inputMicrosPerMillion:'1000000',cacheReadMicrosPerMillion:'1000000',
    cacheWriteMicrosPerMillion:'1000000',outputMicrosPerMillion:'1000000'});
  await operator.reducers.configureRunSpend({runId,pricingVersion:'research-fixture-v1',
    maxSpendMicros:'1000000',maxWorkerSpendMicros:'1000000'});
  runCreated = true;
  for(const conn of clients) call('grant_run_access',conn.identity.toHexString(),runId);
  call('grant_account_access',reader.identity.toHexString(),'fixture-paper');
  const quoteId=`${runId}.quote`;
  await reader.reducers.recordAccountSnapshot({id:`${runId}.account`,accountId:'fixture-paper',accountStatus:'ACTIVE',
    cash:'10000',buyingPower:'10000',equity:'10000',positionsJson:'[]',openOrdersJson:'[]',
    observations:[{id:quoteId,symbol:'QFIX',feed:'iex',bidPrice:'199.90',bidSize:'1',askPrice:'200.10',askSize:'1',asOf:Timestamp.fromDate(new Date())}]});
  const sourceId=`${runId}.source`;
  await ingestor.reducers.addSource({id:sourceId,runId,symbol:'QFIX',kind:'fixture',uri:'fixture://research-check',asOf:Timestamp.fromDate(new Date()),checksum:'fixture',artifactRef:''});
  const factId=`${runId}.fact`;
  await ingestor.reducers.addFact({id:factId,sourceId,symbol:'QFIX',metric:'revenue',value:'0',unit:'USD',period:'fixture',quality:'fixture'});
  for (const mode of ['trade','restart','abstain','invalid','rollback']) {
    const taskId=`${runId}.${mode}`;
    await operator.reducers.createTask({id:taskId,runId,symbol:'QFIX',kind:'thesis',objective:'Exercise synthetic research; no real investment claim',role:'analyst',dependsOn:''});
    await waitFor(()=>analyst.db.myTask.id.find(taskId));
    let task=analyst.db.myTask.id.find(taskId)!;
    await analyst.reducers.claimTask({id:taskId,expectedVersion:task.version});
    await waitFor(()=>analyst.db.mySource.id.find(sourceId)&&analyst.db.myFact.id.find(factId)&&analyst.db.myMarketObservation.id.find(quoteId));
    const thesis=await modelWriteThesis(ask({bull_case:'Synthetic fixture hypothesis',bear_case:'Fixture is not investment evidence',assumptions:'Synthetic prices',invalidation:'Replace with real filings',evidence_ids:[sourceId,factId,quoteId]}),analyst,task,runId);
    assert.equal(thesis.ok,true);
    await modelWriteThesis(neverAsk,analyst,task,runId);
    await analyst.reducers.completeTask({id:taskId,result:thesis.text});
    const reviewId=`review.${taskId}`;
    await coordinator.reducers.createTask({id:reviewId,runId,symbol:'QFIX',kind:'review',objective:'Challenge fixture thesis',role:'skeptic',dependsOn:taskId});
    await waitFor(()=>skeptic.db.myTask.id.find(reviewId)&&skeptic.db.myThesis.id.find(thesis.text));
    task=skeptic.db.myTask.id.find(reviewId)!;
    await skeptic.reducers.claimTask({id:reviewId,expectedVersion:task.version});
    const review=await modelReviewThesis(ask({verdict:'weakens',objections:['Fixture is synthetic'],missing_evidence:['Actual SEC filing'],unsupported_claims:[]}),skeptic,task,runId);
    assert.equal(review.ok,true);
    assert.equal((await modelReviewThesis(neverAsk,skeptic,task,runId)).text,review.text);
    await skeptic.reducers.completeTask({id:reviewId,result:review.text});
    await waitFor(()=>coordinator.db.myTask.id.find(reviewId)?.status==='completed');
    const ids={decisionId:`decision.${thesis.text}`,messageId:`decision.${thesis.text}.msg`};
    const proposalId=`proposal.${thesis.text}`;
    if(mode==='rollback') {
      await assert.rejects(analyst.reducers.recordTradeDecision({decisionId:ids.decisionId,rationale:'Role check',proposalId,runId,thesisId:thesis.text,symbol:'QFIX',side:'buy',quantity:'1',orderType:'market',limitPrice:''}), /Role not authorized/);
      await assert.rejects(coordinator.reducers.recordTradeDecision({decisionId:ids.decisionId,rationale:'Atomic rollback check',proposalId,runId,thesisId:thesis.text,symbol:'QFIX',side:'invalid',quantity:'1',orderType:'market',limitPrice:''}));
      assert.equal(coordinator.db.myDecision.id.find(ids.decisionId),null);
      assert.equal(coordinator.db.myTradeProposal.id.find(proposalId),null);
      console.log('PASS atomic rollback on invalid proposal');
      continue;
    }
    const output={outcome:mode==='abstain'?'abstain':'trade',rationale:'Synthetic fixture checks only',side:mode==='abstain'?null:'buy',quantity:mode==='invalid'?'100':'1',order_type:mode==='abstain'?null:'market',limit_price:null};
    if(mode==='restart') {
      // Simulate a crash after the atomic decision/proposal commit, before its announcement.
      const args={decisionId:ids.decisionId,rationale:output.rationale,proposalId,runId,thesisId:thesis.text,symbol:'QFIX',side:'buy',quantity:'1',orderType:'market',limitPrice:''};
      await coordinator.reducers.recordTradeDecision(args);
      await coordinator.reducers.recordTradeDecision(args);
      coordinator.disconnect();
      coordinatorClient=await connect('coordinator',coordinatorClient.token);
      coordinator=coordinatorClient.conn;
      await modelDecide(neverAsk,coordinator,coordinator.db.myTask.id.find(reviewId)!,thesis.text,runId,ids);
    } else {
      await modelDecide(ask(output),coordinator,coordinator.db.myTask.id.find(reviewId)!,thesis.text,runId,ids);
    }
    await modelDecide(neverAsk,coordinator,coordinator.db.myTask.id.find(reviewId)!,thesis.text,runId,ids);
    assert.equal(coordinator.db.myDecision.id.find(ids.decisionId)?.outcome,mode==='invalid'?'revise':mode==='restart'?'trade':mode);
    assert.equal(Boolean(coordinator.db.myTradeProposal.id.find(proposalId)),mode==='trade'||mode==='restart');
    assert.ok(coordinator.db.myMessage.id.find(ids.messageId));
    assert.equal([...coordinator.db.myMessage.iter()].filter((m:any)=>m.id===ids.messageId).length,1);
    console.log(`PASS ${mode}: thesis, critique, decision, stable replay${mode==='restart'?', coordinator restart':mode==='trade'?', proposal':''}`);
  }
  console.log(`PASS fixture cycle ${runId}; ${calls} schema-validated fixture responses; no provider or broker API calls`);
} finally {
  try { if (runCreated) call('set_run_status',runId,'closed'); }
  finally {
    for(const conn of clients) conn.disconnect();
    for(const id of new Set(clients.map(conn=>conn.identity.toHexString()))) call('revoke_agent',id);
  }
}
