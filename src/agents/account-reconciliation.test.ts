import test from 'node:test';
import assert from 'node:assert/strict';
import { accountDifferences } from '../../spacetimedb/src/account-reconciliation.ts';
const baseline={cash:'1000',positionsJson:'[{"symbol":"AAPL","qty":"2"}]'};
test('cash and share ledger handles partial fractional fills, sells and cent rounding exactly',()=>{
  const fills=[{symbol:'AAPL',side:'buy',quantity:'0.125',price:'100.01'},{symbol:'AAPL',side:'sell',quantity:'0.025',price:'101'}];
  assert.deepEqual(accountDifferences(baseline,{cash:'990.02375',positionsJson:'[{"symbol":"AAPL","qty":"2.1"}]'},fills),[]);
  assert.deepEqual(accountDifferences(baseline,{cash:'990.02',positionsJson:'[{"symbol":"AAPL","qty":"2.100000"}]'},fills),[]);
});
test('external trades, cash changes, missing positions and malformed decimals fail reconciliation',()=>{
  assert.ok(accountDifferences(baseline,{cash:'950',positionsJson:baseline.positionsJson},[]).some(i=>i.startsWith('Cash')));
  assert.ok(accountDifferences(baseline,{cash:'1000',positionsJson:'[]'},[]).some(i=>i.includes('AAPL')));
  assert.ok(accountDifferences(baseline,{cash:'1000',positionsJson:'[{"symbol":"AAPL","qty":"2"},{"symbol":"MSFT","qty":"1"}]'},[]).some(i=>i.includes('MSFT')));
  assert.throws(()=>accountDifferences(baseline,{cash:'NaN',positionsJson:'[]'},[]));
  assert.throws(()=>accountDifferences(baseline,{cash:'1000',positionsJson:'[{"symbol":"AAPL","qty":"2"},{"symbol":"AAPL","qty":"1"}]'},[]));
});
