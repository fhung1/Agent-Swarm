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
  assert.throws(()=>selectEvidence([filing],facts(filing,EVIDENCE_LIMITS.facts+1),[]),PermanentWorkError);
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

test('a complete accession-linked amendment supersedes the old filing in selected evidence only',()=>{
  const asOf = new Date(Date.now() - 2 * 86_400_000).toISOString();
  const earlier = new Date(Date.now() - 20 * 86_400_000).toISOString();
  const annual: SourceView = { id:'annual-original',symbol:'QFIX',kind:'10-K',uri:'https://www.sec.gov/Archives/edgar/data/1/annual.htm',asOf:earlier };
  const amendment: SourceView = { id:'annual-amended',symbol:'QFIX',kind:'10-K/A',uri:'https://www.sec.gov/Archives/edgar/data/1/amended.htm',asOf };
  const quarter: SourceView = { id:'quarter-original',symbol:'QFIX',kind:'10-Q',uri:'https://www.sec.gov/Archives/edgar/data/1/quarter.htm',asOf };
  const narrativeFacts = (filing: SourceView) => ['business','risk_factors','management_discussion'].map(section => ({
    id:`${filing.id}.${section}`,sourceId:filing.id,symbol:filing.symbol,metric:`filing_${section}_01`,
    value:`Amended ${section} disclosure with enough complete context to support a careful analysis.`,unit:'text',period:'item; accession',quality:'ok',
  }));
  const accession = (n: number) => `0000000001-26-${String(n).padStart(6,'0')}`;
  const provenance = (filing: SourceView, number: number, supersedesSourceId?: string): FactView => ({
    id:`${filing.id}.provenance`,sourceId:filing.id,symbol:filing.symbol,metric:'filing_provenance',
    value:JSON.stringify({accession:accession(number),form:filing.kind,reportDate:'2025-12-31',acceptedAt:filing.asOf,
      ...(supersedesSourceId ? {supersedesSourceId} : {})}),unit:'text',period:'filing provenance',quality:'ok',
  });
  const rows=[...narrativeFacts(annual),...narrativeFacts(amendment),...narrativeFacts(quarter),
    provenance(annual,1),provenance(amendment,2,annual.id),provenance(quarter,3)];
  const selected=selectEvidence([annual,amendment,quarter],rows,[]);
  assert.deepEqual(new Set(selected.sources.map(row=>row.id)),new Set([amendment.id,quarter.id]));
  assert.equal(selected.omitted.sources.includes(annual.id),true);
  assert.equal(selected.omitted.facts.some(id=>id.startsWith(`${annual.id}.`)),true);
  assert.ok(selected.allowedIds.has(`${amendment.id}.risk_factors`));
  assert.throws(()=>selectEvidence([annual,amendment,quarter],rows.filter(row=>
    row.sourceId!==amendment.id || row.metric==='filing_provenance'),[]),/missing a fresh/);
});

test('partial amendment remains additive and never suppresses its original filing',()=>{
  const original=source('original','10-K',1);
  const amendment=source('partial','10-K/A',2);
  const quarterly=source('quarter','10-Q',3);
  const metadata:FactView={id:'partial.provenance',sourceId:amendment.id,symbol:amendment.symbol,metric:'filing_provenance',
    value:JSON.stringify({accession:'0000000001-26-000002',form:'10-K/A',reportDate:'2025-12-31',acceptedAt:amendment.asOf}),
    unit:'text',period:'filing provenance',quality:'ok'};
  const selected=selectEvidence([original,amendment,quarterly],[metadata],[]);
  assert.ok(selected.sources.some(row=>row.id===original.id));
  assert.ok(selected.sources.some(row=>row.id===amendment.id));
  assert.ok(!selected.omitted.sources.includes(original.id));
});

test('event filings are optional evidence and update markers stay accession linked',()=>{
  const annual=source('annual','10-K',1);
  const event:SourceView={...source('event','8-K',2),uri:'https://www.sec.gov/Archives/edgar/data/1/event.htm'};
  const eventFacts:FactView[]=[
    {id:'event.provenance',sourceId:event.id,symbol:event.symbol,metric:'filing_provenance',
      value:JSON.stringify({accession:'0000000001-26-000004',form:'8-K',reportDate:'2026-09-20',acceptedAt:event.asOf}),unit:'text',period:'accession',quality:'ok'},
    {id:'event.review',sourceId:event.id,symbol:event.symbol,metric:'filing_update_review',value:'review_required',unit:'text',period:'Item 4.02; accession 0000000001-26-000004',quality:'ok'},
    {id:'event.item',sourceId:event.id,symbol:event.symbol,metric:'filing_event_4_02',value:'The filing states the prior financial statements should no longer be relied on.',unit:'text',period:'Item 4.02; accession 0000000001-26-000004',quality:'ok'},
  ];
  const selected=selectEvidence([annual,event],[...facts(annual,3),...eventFacts],[]);
  assert.ok(selected.sources.some(row=>row.id===event.id));
  assert.ok(selected.facts.some(row=>row.metric==='filing_update_review'));
  assert.ok(selected.allowedIds.has('event.item'));
});
