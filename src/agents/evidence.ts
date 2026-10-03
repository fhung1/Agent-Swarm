import type { SourceView, FactView, ObservationView } from './roles.ts';
import { PermanentWorkError } from '../work-errors.ts';

// Source groups are indivisible: including a filing includes all its recorded facts.
// Limits also respect the module's 50-reference / 4096-character reducer protocol.
export const EVIDENCE_LIMITS = { sources: 6, facts: 40, refs: 49, refChars: 3967, chars: 30000 } as const;
export const MAX_PROMPT_CHARS = 48000;
export interface EvidenceOmissions { sources: string[]; facts: string[]; observations: string[] }
export interface EvidenceSelection {
  sources: SourceView[]; facts: FactView[]; observations: ObservationView[];
  omitted: EvidenceOmissions; allowedIds: ReadonlySet<string>; refs: string;
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const recent = <T extends { id: string; asOf: string }>(a: T, b: T) =>
  Date.parse(b.asOf) - Date.parse(a.asOf) || compare(a.id, b.id);
const metricOrder = (a: FactView, b: FactView) => compare(a.metric,b.metric) || compare(a.id,b.id);

export function evidenceText(sources: SourceView[], facts: FactView[], observations: ObservationView[],
  omitted: EvidenceOmissions = {sources:[],facts:[],observations:[]}): string {
  const rows = [
    ...sources.map(s => `source ${s.id}: ${s.symbol} ${s.kind} ${s.uri}, as of ${s.asOf}`),
    ...sources.flatMap(s => s.qualitative ? [
      ...s.qualitative.sections.map(row => `filing excerpt from source ${s.id}, ${row.section}, normalized lines ${row.startLine}-${row.endLine}, omitted ${row.charactersOmitted} characters: ${JSON.stringify(row.text)}`),
      ...s.qualitative.missing.map(reason => `source ${s.id} qualitative evidence unavailable: ${reason}`),
    ] : []),
    ...facts.map(f => `fact ${f.id} (from ${f.sourceId}): ${f.symbol} ${f.metric} = ${f.value} ${f.unit}, period ${f.period}, quality ${f.quality}`),
    ...observations.map(o => `market observation ${o.id}: ${o.symbol} bid ${o.bidPrice} ask ${o.askPrice} (${o.feed}), as of ${o.asOf}`),
  ];
  const omissions = (['sources','facts','observations'] as const).filter(kind=>omitted[kind].length)
    .map(kind=>`${kind}: ${omitted[kind].length}; IDs: ${omitted[kind].join(', ')}`);
  return `<evidence>\n${rows.length ? rows.join('\n') : '(none)'}\n</evidence>` +
    (omissions.length ? `\n<omitted_evidence>\nThese IDs were omitted by source, recency, reference or prompt limits and are NOT available for citation.\n${omissions.join('\n')}\n</omitted_evidence>` : '');
}

export function assertPromptBudget(system: string, prompt: string): void {
  if (system.length + prompt.length > MAX_PROMPT_CHARS) throw new PermanentWorkError(
    `Minimum required evidence cannot fit the ${MAX_PROMPT_CHARS}-character prompt budget`);
}

export function selectEvidence(allSources: SourceView[], allFacts: FactView[], allObservations: ObservationView[]): EvidenceSelection {
  for (const row of [...allSources,...allObservations]) if (!Number.isFinite(Date.parse(row.asOf))) {
    throw new PermanentWorkError(`Invalid evidence date: ${row.id}`);
  }
  const sourceRows = [...allSources].sort(recent);
  const filings = ['10-K','10-Q'].flatMap(kind => {
    const source = sourceRows.find(s=>s.kind===kind); return source ? [source] : [];
  }).sort(recent);
  const required = filings.length ? filings : sourceRows.slice(0,1);
  const requiredIds = new Set(required.map(s=>s.id));
  const optional = sourceRows.filter(s=>s.kind!=='10-K' && s.kind!=='10-Q' && !requiredIds.has(s.id));
  const groups = new Map(sourceRows.map(s=>[s.id, allFacts.filter(f=>f.sourceId===s.id).sort(metricOrder)]));
  const latest = new Map<string,ObservationView>();
  for (const quote of [...allObservations].sort(recent)) if (!latest.has(quote.feed)) latest.set(quote.feed,quote);
  const observations = [...latest.values()].sort((a,b)=>compare(a.feed,b.feed));
  function candidate(sources: SourceView[]): EvidenceSelection {
    const ordered = [...sources].sort(recent);
    const facts = ordered.flatMap(s=>groups.get(s.id)!);
    const selectedIds = new Set([...ordered,...facts,...observations].map(row=>row.id));
    const omitted = {
      sources: allSources.filter(s=>!selectedIds.has(s.id)).map(s=>s.id).sort(compare),
      facts: allFacts.filter(f=>!selectedIds.has(f.id)).map(f=>f.id).sort(compare),
      observations: allObservations.filter(o=>!selectedIds.has(o.id)).map(o=>o.id).sort(compare),
    };
    return {sources:ordered,facts,observations,omitted,allowedIds:selectedIds,refs:[...selectedIds].join(',')};
  }
  function fits(value: EvidenceSelection): boolean {
    return value.sources.length <= EVIDENCE_LIMITS.sources && value.facts.length <= EVIDENCE_LIMITS.facts &&
      value.allowedIds.size <= EVIDENCE_LIMITS.refs && value.refs.length <= EVIDENCE_LIMITS.refChars &&
      evidenceText(value.sources,value.facts,value.observations,value.omitted).length <= EVIDENCE_LIMITS.chars;
  }
  let selected = required;
  if (!fits(candidate(selected))) throw new PermanentWorkError('Minimum required filing evidence cannot fit source, fact, reference or prompt limits');
  for (const source of optional) if (fits(candidate([...selected,source]))) selected = [...selected,source];
  // With no SEC filing, require at least the newest source rather than silently showing quotes alone.
  if (!selected.length && sourceRows.length) throw new PermanentWorkError('Minimum required source evidence cannot fit source, fact, reference or prompt limits');
  return candidate(selected);
}
