import test from 'node:test';
import assert from 'node:assert/strict';
import { submissionBlock, type SubmissionInput } from './submission.ts';
const now=new Date('2026-10-05T15:00:00Z');
function fixture():SubmissionInput {
  const quote={id:'quote-1',symbol:'AAPL',bidPrice:'99',askPrice:'100',asOf:now};
  return {connected:true,authorized:true,accountId:'paper-1',reservationAccountId:'paper-1',policyId:'policy-1',snapshotId:'snapshot-1',quoteId:quote.id,
    reconciliationStatus:'matched',risk:{outcome:'pass',expiresAt:new Date(now.getTime()+60000),policyId:'policy-1',snapshotId:'snapshot-1',quoteId:quote.id},
    policy:{version:'policy-1',allowedSymbols:['AAPL'],longOnly:true,maxOrderNotional:1000,maxPositionNotional:2500,maxQuoteAgeMs:60000,maxAccountAgeMs:60000,maxLimitDeviation:0.03,approvalTtlMs:60000,maxProposalAgeMs:900000,requireMarketOpen:true},
    input:{proposal:{id:'p1',symbol:'AAPL',side:'buy',quantity:'1',orderType:'market',limitPrice:'',createdAt:now},pendingIntents:[],quote,quotes:[quote],account:{status:'ACTIVE',buyingPower:'10000',positionsJson:'[]',openOrdersJson:'[]',capturedAt:now},runStatus:'active',marketOpen:true,now}};
}
test('fresh reserved intent can submit, but changed inputs cannot',()=>{
  assert.equal(submissionBlock(fixture()),undefined);
  for(const change of [{connected:false},{authorized:false},{reservationAccountId:'other'},{reconciliationStatus:'mismatch'},{snapshotId:'new'},{quoteId:'new'},{policyId:'new'}])assert.ok(submissionBlock({...fixture(),...change}));
});
test('pause, pass expiry and stale data between reserve and POST fail closed',()=>{
  const paused=fixture();paused.input.runStatus='paused';assert.ok(submissionBlock(paused));
  const expired=fixture();expired.risk!.expiresAt=now;assert.ok(submissionBlock(expired));
  const stale=fixture();stale.input.now=new Date(now.getTime()+120000);stale.risk!.expiresAt=new Date(now.getTime()+300000);assert.ok(submissionBlock(stale));
});
