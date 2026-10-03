import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectEvidence, assertNarrativeCitations, assertPromptBudget, EVIDENCE_LIMITS, MAX_PROMPT_CHARS } from './evidence.ts';
import { analystPrompt, toPublishThesisArgs, type SourceView, type FactView, type ObservationView } from './roles.ts';
import { PermanentWorkError } from '../work-errors.ts';

function source(id: string, kind = 'fixture', day = 1): SourceView {
  return { id, symbol:'QFIX', kind, uri:`fixture://${id}`, asOf:`2026-09-${String(day).padStart(2,'0')}T00:00:00Z` };
}
function facts(s: SourceView, count: number): FactView[] {
  return Array.from({length:count},(_,i)=>({ id:`${s.id}.fact.${i}`, sourceId:s.id, symbol:s.symbol,
    metric:`metric.${String(i).padStart(2,'0')}`, value:String(i), unit:'USD',period:'fixture',quality:'ok' }));
}
function shuffled<T>(rows: T[], seed: number): T[] {
  const copy = [...rows];
  for (let i=copy.length-1;i>0;i--) { seed=(seed*1664525+1013904223)>>>0; const j=seed%(i+1); [copy[i],copy[j]]=[copy[j],copy[i]]; }
  return copy;
}
const output = {bull_case:'Fixture',bear_case:'Fixture',assumptions:'Fixture',invalidation:'Fixture',evidence_ids:[] as string[]};
const ids = {thesisId:'thesis',runId:'fixture',taskId:'task',symbol:'QFIX'};

test('both latest SEC filings retain all 20 facts across five insertion-order shuffles',()=>{
  const sources=[source('annual','10-K',1),source('quarter','10-Q',2)];
  const rows=sources.flatMap(s=>facts(s,10));
  let previous='';
  for(let seed=1;seed<=5;seed++) {
    const selected=selectEvidence(shuffled(sources,seed),shuffled(rows,seed),[]);
    const prompt=analystPrompt('QFIX','Research',selected.sources,selected.facts,selected.observations,selected.omitted);
    assert.equal(selected.facts.length,20);
    for(const fact of rows) assert.ok(prompt.includes(`fact ${fact.id} (from`));
    if(previous) assert.equal(prompt,previous); previous=prompt;
    assert.equal(selected.allowedIds.size,22);
  }
});

test('older SEC filings and whole over-cap source groups are disclosed and not citable',()=>{
  const sources=[source('old-annual','10-K',1),source('annual','10-K',2),source('quarter','10-Q',3),
    ...Array.from({length:8},(_,i)=>source(`other-${i}`,'news',i+4))];
  const rows=sources.flatMap(s=>facts(s,2));
  const selected=selectEvidence(sources,rows,[]);
  assert.equal(selected.sources.length,EVIDENCE_LIMITS.sources);
  assert.equal(selected.allowedIds.has('old-annual'),false);
  assert.ok(selected.omitted.sources.length);
  const prompt=analystPrompt('QFIX','Research',selected.sources,selected.facts,selected.observations,selected.omitted);
  assert.ok(prompt.includes(`sources: ${selected.omitted.sources.length}; IDs:`));
  for(const id of [...selected.omitted.sources,...selected.omitted.facts]) {
    assert.ok(prompt.includes(id));
    assert.throws(()=>toPublishThesisArgs({...output,evidence_ids:[id]},ids,selected.allowedIds),/unknown evidence/);
  }
  for(const s of selected.sources) assert.equal(selected.facts.filter(f=>f.sourceId===s.id).length,2);
});

test('only the latest quote per feed is shown, with deterministic timestamp ties',()=>{
  const quote=(id:string,feed:string,day:number):ObservationView=>({ id,symbol:'QFIX',feed,bidPrice:'1',askPrice:'2',asOf:source(id,'fixture',day).asOf });
  const observations=[quote('old','iex',1),quote('new-b','iex',2),quote('new-a','iex',2),quote('sip','sip',1)];
  const selected=selectEvidence([source('filing')],[],observations);
  assert.deepEqual(selected.observations.map(o=>o.id),['new-a','sip']);
  assert.deepEqual(selected.omitted.observations,['new-b','old']);
});

test('minimum required evidence that exceeds bounds fails permanently without partial facts',()=>{
  const filing=source('annual','10-K');
  assert.throws(()=>selectEvidence([filing],facts(filing,41),[]),PermanentWorkError);
  assert.throws(()=>selectEvidence([{...filing,uri:'x'.repeat(EVIDENCE_LIMITS.chars)}],[],[]),PermanentWorkError);
  assert.throws(()=>selectEvidence([{...filing,asOf:'bad'}],[],[]),PermanentWorkError);
  assert.throws(()=>assertPromptBudget('system','x'.repeat(MAX_PROMPT_CHARS)),PermanentWorkError);
  assert.doesNotThrow(()=>assertPromptBudget('system','Small prompt'));
});

test('selection reserves space for a skeptic thesis reference in the reducer protocol',()=>{
  const filing=source('s'.repeat(128),'10-K');
  const rows=facts(filing,20).map((f,i)=>({...f,id:`${i}.`+'f'.repeat(124)}));
  const selected=selectEvidence([filing],rows,[]);
  assert.ok(selected.refs.length+129<=4096);
  assert.ok(selected.allowedIds.size+1<=50);
});

test('qualitative filing excerpts use source citations and count toward the evidence budget',()=>{
  const filing=source('annual','10-K');
  filing.qualitative={ sections:[{section:'risk_factors',text:'Supplier concentration could disrupt production.',
    startLine:10,endLine:12,charactersOmitted:2000,startOffset:100,endOffset:146,quality:'ok'}],missing:['mda: heading not found'] };
  const selected=selectEvidence([filing],facts(filing,10),[]);
  const prompt=analystPrompt('QFIX','Research',selected.sources,selected.facts,[],selected.omitted);
  assert.ok(prompt.includes('filing excerpt from source annual, risk_factors'));
  assert.ok(prompt.includes('Supplier concentration'));
  assert.ok(prompt.includes('omitted 2000 characters'));
  assert.ok(prompt.includes('mda: heading not found'));
  assert.equal(selected.allowedIds.size,11);
  assert.doesNotThrow(()=>toPublishThesisArgs({...output,evidence_ids:['annual']},ids,selected.allowedIds));
  assert.throws(()=>toPublishThesisArgs({...output,evidence_ids:['risk_factors']},ids,selected.allowedIds),/unknown evidence/);
  filing.qualitative.sections[0].text='x'.repeat(EVIDENCE_LIMITS.chars);
  assert.throws(()=>selectEvidence([filing],facts(filing,10),[]),PermanentWorkError);
});

test('fresh SEC filings require all supported narrative sections and their citations',()=>{
  const asOf = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const annual: SourceView = { id:'annual-sec', symbol:'QFIX', kind:'10-K', uri:'https://www.sec.gov/Archives/edgar/data/1/annual.htm', asOf };
  const narrative: FactView[] = [
    ['business','business excerpt with enough text to establish useful filing context.'],
    ['risk_factors','risk factors excerpt with enough text to describe a material business risk.'],
    ['management_discussion','management discussion excerpt with enough text to describe operating results.'],
  ].map(([section,value])=>({ id:`annual-sec.${section}`, sourceId:annual.id, symbol:annual.symbol,
    metric:`filing_${section}_01`, value:value.repeat(2), unit:'text', period:'Item; accession; accepted date', quality:'ok' }));
  const selected = selectEvidence([annual], narrative, []);
  assert.deepEqual(selected.narrativeRefs, {
    business:['annual-sec.business'], risk_factors:['annual-sec.risk_factors'],
    management_discussion:['annual-sec.management_discussion'],
  });
  assert.doesNotThrow(()=>assertNarrativeCitations('annual-sec.business,annual-sec.risk_factors,annual-sec.management_discussion',selected.narrativeRefs));
  assert.throws(()=>assertNarrativeCitations('annual-sec.business,annual-sec.management_discussion',selected.narrativeRefs),/risk factors/);

  assert.throws(()=>selectEvidence([annual],narrative.filter(fact=>fact.metric!=='filing_business_01'),[]),/missing a fresh business/);
});

test('stale SEC evidence fails closed before thesis selection',()=>{
  const stale: SourceView = { id:'stale-sec', symbol:'QFIX', kind:'10-Q', uri:'https://www.sec.gov/Archives/edgar/data/1/stale.htm',
    asOf:new Date(Date.now() - 401 * 86_400_000).toISOString() };
  const narrative: FactView[] = ['risk_factors','management_discussion'].map(section=>({ id:`stale-sec.${section}`,
    sourceId:stale.id,symbol:stale.symbol,metric:`filing_${section}_01`,value:'A sufficiently long stale filing excerpt with cited context.',
    unit:'text',period:'Item; accession; accepted date',quality:'ok' }));
  assert.throws(()=>selectEvidence([stale],narrative,[]),/older than 400 days/);
});
