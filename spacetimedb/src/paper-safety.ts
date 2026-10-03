import { t, SenderError } from 'spacetimedb/server';
import spacetimedb from './schema';
import { requireRole, requireId, requireRun, requireRunAccess, requireText, type Ctx } from './access';
import { requireCurrentRisk } from './risk-gate';
import { parseOpenOrders, parsePositions } from './risk';
import { accountDifferences, type LedgerFill } from './account-reconciliation';

function access(ctx:Ctx,accountId:string){if(!ctx.db.accountAccess.id.find(`${ctx.sender.toHexString()}:${accountId}`))throw new SenderError('Account access required');}
export const reconcilePaperAccount=spacetimedb.reducer({id:t.string(),accountId:t.string(),cash:t.string(),positionsJson:t.string(),openOrdersJson:t.string(),issues:t.string()},(ctx,v)=>{
  requireRole(ctx,['executor']);access(ctx,v.accountId);requireId(v.id);
  if(v.positionsJson.length>1000000||v.openOrdersJson.length>1000000||v.issues.length>4000)throw new SenderError('Account reconciliation payload too large');
  parsePositions(v.positionsJson);parseOpenOrders(v.openOrdersJson);
  const orders=[...ctx.db.riskReservation.accountId.filter(v.accountId)].flatMap(r=>{const order=ctx.db.paperOrder.proposalId.find(r.proposalId);return order?[order]:[];});
  const open=JSON.parse(v.openOrdersJson) as {client_order_id?:string}[];
  let baseline=ctx.db.accountLedger.accountId.find(v.accountId);
  const issues:string[]=v.issues?[v.issues]:[];
  for(const order of orders)if(!order.alpacaOrderId&&order.status==='submitting'&&[...ctx.db.paperSubmission.orderId.filter(order.id)].length>=3)issues.push(`Submission retry limit reached with unresolved broker outcome: ${order.id}`);
  if(!baseline){
    if(open.length||orders.some(o=>o.alpacaOrderId||[...ctx.db.paperSubmission.orderId.filter(o.id)].length))issues.push('Cannot initialize ledger with existing broker activity; explicit operator baseline required');
    else {accountDifferences({cash:v.cash,positionsJson:v.positionsJson},{cash:v.cash,positionsJson:v.positionsJson},[]);baseline=ctx.db.accountLedger.insert({accountId:v.accountId,cash:v.cash,positionsJson:v.positionsJson,createdAt:ctx.timestamp});}
  }
  if(baseline){
    const fills:LedgerFill[]=orders.flatMap(o=>{const p=ctx.db.tradeProposal.id.find(o.proposalId)!;return [...ctx.db.fill.orderId.filter(o.id)].filter(f=>f.filledAt.microsSinceUnixEpoch>=baseline!.createdAt.microsSinceUnixEpoch).map(f=>({symbol:p.symbol,side:p.side,quantity:f.quantity,price:f.price}));});
    issues.push(...accountDifferences(baseline,v,fills));
  }
  const known=new Set(orders.map(o=>o.clientOrderId));
  for(const row of open)if(!row.client_order_id||!known.has(row.client_order_id))issues.push(`Untracked broker order ${row.client_order_id??'without client ID'}`);
  const check={accountId:v.accountId,status:issues.length?'mismatch':'matched',details:(issues.join('; ')||'Cash, positions, open orders and fills match durable ledger').slice(0,4000),checkedAt:ctx.timestamp};
  if(ctx.db.accountCheck.accountId.find(v.accountId))ctx.db.accountCheck.accountId.update(check);else ctx.db.accountCheck.insert(check);
  ctx.db.reconciliation.insert({id:v.id,accountId:v.accountId,status:check.status,details:check.details,capturedAt:ctx.timestamp});
});

// Recovery is explicit and audited; normal reconciliation never silently resets a mismatch.
export const setPaperAccountBaseline=spacetimedb.reducer({accountId:t.string(),snapshotId:t.string(),evidence:t.string()},(ctx,v)=>{
  requireRole(ctx,['operator']);access(ctx,v.accountId);requireText(v.evidence,'Baseline evidence',2000);
  const snapshot=ctx.db.accountSnapshot.id.find(v.snapshotId);
  if(!snapshot||snapshot.accountId!==v.accountId||ctx.timestamp.microsSinceUnixEpoch-snapshot.capturedAt.microsSinceUnixEpoch>60000000n||JSON.parse(snapshot.openOrdersJson).length)throw new SenderError('Fresh snapshot without open orders required');
  for(const r of ctx.db.riskReservation.accountId.filter(v.accountId)){const p=ctx.db.tradeProposal.id.find(r.proposalId)!;if(ctx.db.run.id.find(p.runId)?.status==='active')throw new SenderError('Pause all account runs before resetting baseline');const o=ctx.db.paperOrder.proposalId.find(p.id);if(o&&!['filled','canceled','expired','rejected','replaced'].includes(o.status))throw new SenderError('Resolve every outstanding intent before resetting baseline');}
  accountDifferences(snapshot,snapshot,[]);
  const row={accountId:v.accountId,cash:snapshot.cash,positionsJson:snapshot.positionsJson,createdAt:snapshot.capturedAt};
  if(ctx.db.accountLedger.accountId.find(v.accountId))ctx.db.accountLedger.accountId.update(row);else ctx.db.accountLedger.insert(row);
  const check={accountId:v.accountId,status:'pending',details:`Operator baseline reset: ${v.evidence}`,checkedAt:ctx.timestamp};
  if(ctx.db.accountCheck.accountId.find(v.accountId))ctx.db.accountCheck.accountId.update(check);else ctx.db.accountCheck.insert(check);
  ctx.db.reconciliation.insert({id:`baseline.${ctx.timestamp.microsSinceUnixEpoch}`,accountId:v.accountId,status:'resolved',details:check.details,capturedAt:ctx.timestamp});
});

export const beginPaperSubmission=spacetimedb.reducer({id:t.string(),orderId:t.string(),expectedAttempts:t.u32()},(ctx,v)=>{
  requireRole(ctx,['executor']);requireId(v.id);
  const order=ctx.db.paperOrder.id.find(v.orderId);if(!order||order.alpacaOrderId||order.status!=='submitting')throw new SenderError('Unsubmitted order required');
  const proposal=ctx.db.tradeProposal.id.find(order.proposalId)!;requireRun(ctx,proposal.runId);
  const reservation=ctx.db.riskReservation.proposalId.find(proposal.id)!;access(ctx,reservation.accountId);
  const attempts=[...ctx.db.paperSubmission.orderId.filter(order.id)].sort((a,b)=>b.attempt-a.attempt);
  if(attempts.length!==v.expectedAttempts||attempts.length>=3||ctx.db.paperSubmission.id.find(v.id))throw new SenderError('Submission attempt changed or retry limit reached');
  if(attempts[0]&&ctx.timestamp.microsSinceUnixEpoch-attempts[0].startedAt.microsSinceUnixEpoch<60000000n)throw new SenderError('Submission uncertainty grace has not elapsed');
  requireCurrentRisk(ctx,proposal.id);
  const check=ctx.db.accountCheck.accountId.find(reservation.accountId);
  if(!check||check.status!=='matched'||ctx.timestamp.microsSinceUnixEpoch-check.checkedAt.microsSinceUnixEpoch>60000000n)throw new SenderError('Fresh full account reconciliation required');
  ctx.db.paperSubmission.insert({id:v.id,orderId:v.orderId,actor:ctx.sender,attempt:attempts.length+1,status:'started',details:'Broker request may follow; retain exposure until reconciled',startedAt:ctx.timestamp,updatedAt:ctx.timestamp});
  ctx.db.accountCheck.accountId.update({...check,status:'pending',details:'Submission in progress; reconcile before another submission'});
});
export const finishPaperSubmission=spacetimedb.reducer({id:t.string(),status:t.string(),details:t.string()},(ctx,v)=>{
  requireRole(ctx,['executor']);requireText(v.details,'Submission details',2000);
  const old=ctx.db.paperSubmission.id.find(v.id);if(!old||!old.actor.equals(ctx.sender))throw new SenderError('Submission not owned');
  const order=ctx.db.paperOrder.id.find(old.orderId)!;const proposal=ctx.db.tradeProposal.id.find(order.proposalId)!;
  requireRunAccess(ctx,proposal.runId);access(ctx,ctx.db.riskReservation.proposalId.find(proposal.id)!.accountId);
  if(!['accepted','refused','uncertain','retry','duplicate'].includes(v.status))throw new SenderError('Invalid submission result');
  if(old.status!=='started'){if(old.status===v.status&&old.details===v.details)return;throw new SenderError('Submission result immutable');}
  ctx.db.paperSubmission.id.update({...old,...v,updatedAt:ctx.timestamp});
});
export const resolveUncertainPaperIntent=spacetimedb.reducer({orderId:t.string(),clientOrderId:t.string(),evidence:t.string()},(ctx,v)=>{
  requireRole(ctx,['operator']);requireText(v.evidence,'Broker absence evidence',2000);
  const order=ctx.db.paperOrder.id.find(v.orderId);if(!order||order.alpacaOrderId||order.status!=='submitting'||order.clientOrderId!==v.clientOrderId)throw new SenderError('Unsubmitted uncertain intent with matching client ID required');
  const p=ctx.db.tradeProposal.id.find(order.proposalId)!;if(ctx.db.run.id.find(p.runId)?.status!=='paused')throw new SenderError('Pause the run before resolving uncertainty');
  const reservation=ctx.db.riskReservation.proposalId.find(p.id)!;access(ctx,reservation.accountId);
  const attempts=[...ctx.db.paperSubmission.orderId.filter(order.id)];
  if(attempts.some(a=>ctx.timestamp.microsSinceUnixEpoch-a.startedAt.microsSinceUnixEpoch<60000000n))throw new SenderError('Wait for submission uncertainty grace before reconciliation');
  ctx.db.paperOrder.id.update({...order,status:'rejected',updatedAt:ctx.timestamp});
  ctx.db.reconciliation.insert({id:`intent-resolution.${ctx.timestamp.microsSinceUnixEpoch}`,accountId:reservation.accountId,status:'resolved',details:`Operator confirmed broker absence for ${order.id}/${order.clientOrderId}: ${v.evidence}`,capturedAt:ctx.timestamp});
  // A fresh full account check, not this operator assertion, clears the account interlock.
});
