import type { DbConnection } from '../module_bindings/index.js';
import type { Fact, MarketObservation, Source, Task, Thesis } from '../module_bindings/types.js';
import { recordId } from '../ids.js';
import { accountedAsk, PROMPT_VERSION } from './accounted-ask.js';
import { isPermanent } from '../work-errors.js';
import type { Ask } from './llm.js';
import { selectEvidence, assertNarrativeCitations, assertPromptBudget } from './evidence.js';
import {
  ANALYST_SYSTEM, AnalystOutput, COORDINATOR_SYSTEM, CoordinatorOutput, SKEPTIC_SYSTEM, SkepticOutput,
  analystPrompt, coordinatorPrompt, skepticPrompt, toCritiqueMessageArgs, toDecisionArgs, toProposalArgs,
  toPublishThesisArgs, type FactView, type ObservationView, type SourceView, type ThesisView,
} from './roles.js';

// Model-backed versions of the worker's placeholder analyst, skeptic, and coordinator steps.
// `ask` is a Claude or Codex structured-output call from llm.ts; the steps do not depend on which.
// IDs match the rule-based worker so a restarted worker, in any mode, resumes the same records.

export interface Outcome { ok: boolean; text: string }

const MAX_ORDER_NOTIONAL = Number(process.env.MAX_ORDER_NOTIONAL ?? '1000');
if (!Number.isFinite(MAX_ORDER_NOTIONAL) || MAX_ORDER_NOTIONAL <= 0) throw new Error('MAX_ORDER_NOTIONAL must be a positive number');
// A failed coordinator call is retried after this delay instead of on every table update.
const DECIDE_RETRY_MS = 5 * 60_000;
const decideRetryAt = new Map<string, number>();

function clip(text: string, max = 4000): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const sourceView = (s: Source): SourceView => ({ id: s.id, symbol: s.symbol, kind: s.kind, uri: s.uri, asOf: s.asOf.toISOString() });
const factView = (f: Fact): FactView => ({
  id: f.id, sourceId: f.sourceId, symbol: f.symbol, metric: f.metric, value: f.value, unit: f.unit, period: f.period, quality: f.quality,
});
const thesisView = (t: Thesis): ThesisView => ({
  id: t.id, runId: t.runId, symbol: t.symbol, bullCase: t.bullCase, bearCase: t.bearCase,
  assumptions: t.assumptions, invalidation: t.invalidation, evidenceRefs: t.evidenceRefs,
});
const observationView = (o: MarketObservation): ObservationView => ({
  id: o.id, symbol: o.symbol, feed: o.feed, bidPrice: o.bidPrice, askPrice: o.askPrice, asOf: o.asOf.toISOString(),
});

export function evidenceFor(conn: DbConnection, runId: string, symbol: string) {
  const sources = [...conn.db.mySource.iter()]
    .filter(source => source.runId === runId && source.symbol === symbol)
    .sort((a, b) => a.id.localeCompare(b.id));
  const sourceIds = new Set(sources.map(source => source.id));
  const facts = [...conn.db.myFact.iter()]
    .filter(fact => sourceIds.has(fact.sourceId))
    .sort((a, b) => a.id.localeCompare(b.id));
  const observations = [...conn.db.myMarketObservation.iter()]
    .filter(observation => observation.symbol === symbol)
    .sort((a, b) => Number(a.asOf.microsSinceUnixEpoch - b.asOf.microsSinceUnixEpoch));
  return selectEvidence(sources.map(sourceView),facts.map(factView),observations.map(observationView));
}

export async function modelWriteThesis(ask: Ask, conn: DbConnection, task: Task, runId: string, signal?: AbortSignal): Promise<Outcome> {
  const thesisId = recordId('thesis.', task.id);
  // A resumed task may already have published its thesis; do not pay for a second model call.
  if (!conn.db.myThesis.id.find(thesisId)) {
    const { sources, facts, observations, omitted, allowedIds: allowed, refs, narrativeRefs } = evidenceFor(conn, runId, task.symbol);
    if (sources.length === 0) return { ok: false, text: `No stored sources for ${task.symbol} in run ${runId}` };
    const prompt = analystPrompt(task.symbol, task.objective, sources, facts, observations, omitted);
    assertPromptBudget(ANALYST_SYSTEM,prompt);
    const output = await accountedAsk(ask, conn, runId, task.id, refs, signal)(AnalystOutput, ANALYST_SYSTEM,
      prompt);
    await conn.reducers.publishThesis(
      toPublishThesisArgs(output, { thesisId, runId, taskId: task.id, symbol: task.symbol }, allowed, narrativeRefs));
  }
  if (!conn.db.myMessage.id.find(recordId('', thesisId, '.claim'))) await conn.reducers.postMessage({
    id: recordId('', thesisId, '.claim'), runId, taskId: task.id, symbol: task.symbol, recipientRole: 'coordinator',
    kind: 'claim', body: `Thesis ${thesisId} published for ${task.symbol}`, evidenceRef: thesisId,
  });
  return { ok: true, text: thesisId };
}

export async function modelReviewThesis(ask: Ask, conn: DbConnection, task: Task, runId: string, signal?: AbortSignal): Promise<Outcome> {
  const thesisId = conn.db.myTask.id.find(task.dependsOn)?.result ?? '';
  const thesis = conn.db.myThesis.id.find(thesisId);
  if (!thesis) return { ok: false, text: `Thesis ${thesisId || '(none)'} for dependency ${task.dependsOn} not found` };
  if (thesis.symbol !== task.symbol) return { ok: false, text: `Thesis ${thesisId} is for ${thesis.symbol}, not ${task.symbol}` };
  const messageId = recordId('', task.id, '.challenge');
  let body = conn.db.myMessage.id.find(messageId)?.body;
  if (!body) {
    // The skeptic sees all run evidence for the symbol, so it can point out what the thesis left out.
    const { sources, facts, observations, omitted } = evidenceFor(conn, runId, task.symbol);
    const refs = [thesisId, ...sources.map(s => s.id), ...facts.map(f => f.id), ...observations.map(o => o.id)].join(',');
    const prompt = skepticPrompt(thesisView(thesis), sources, facts, observations, omitted);
    assertPromptBudget(SKEPTIC_SYSTEM,prompt);
    const output = await accountedAsk(ask, conn, runId, task.id, refs, signal)(SkepticOutput, SKEPTIC_SYSTEM,prompt);
    const args = toCritiqueMessageArgs(output, { messageId, runId, taskId: task.id, symbol: task.symbol, thesisId });
    await conn.reducers.postMessage(args);
    body = args.body;
  }
  // A worker restarted with a different brain can encounter a rule-based challenge.
  if (!body.startsWith('{')) return { ok: true, text: clip(body) };
  const critique = SkepticOutput.parse(JSON.parse(body));
  // The rule-based coordinator treats a result starting with "pass" as a clean review.
  const prefix = critique.verdict === 'supports' ? 'pass' : 'concerns';
  return { ok: true, text: clip(`${prefix} (${critique.verdict}): ${critique.objections[0] ?? 'no objections'}`) };
}

export async function modelDecide(
  ask: Ask, conn: DbConnection, reviewTask: Task, thesisId: string, runId: string,
  ids: { decisionId: string; messageId: string }, signal?: AbortSignal,
): Promise<void> {
  if ((decideRetryAt.get(ids.decisionId) ?? 0) > Date.now()) return;
  try {
    const thesis = conn.db.myThesis.id.find(thesisId)!;
    // A decision recorded before a crash is reused; only its announcement is re-sent.
    const existing = [...conn.db.myDecision.iter()].find(row => row.thesisId === thesisId);
    let summary = existing ? { outcome: existing.outcome, rationale: existing.rationale } : undefined;
    let proposalNote = '';
    if (!summary) {
      const currentEvidence = evidenceFor(conn, runId, thesis.symbol);
      assertNarrativeCitations(thesis.evidenceRefs, currentEvidence.narrativeRefs);
      let input = conn.db.myDecisionInput.id.find(ids.decisionId);
      if (!input) {
        const critiques = [...conn.db.myMessage.iter()]
          .filter(m => m.runId === runId && m.kind === 'challenge' && m.evidenceRef === thesisId)
          .sort((a, b) => a.id.localeCompare(b.id)).slice(0, 20);
        const quote = [...conn.db.myMarketObservation.iter()]
          .filter(o => o.symbol === thesis.symbol && o.asOf.microsSinceUnixEpoch <= BigInt(Date.now()) * 1000n)
          .sort((a, b) => Number(b.asOf.microsSinceUnixEpoch - a.asOf.microsSinceUnixEpoch))[0];
        const policyId = conn.db.myRunConfig.runId.find(runId)?.policyId ?? '';
        const policy = policyId ? conn.db.myRiskPolicy.id.find(policyId) : undefined;
        const orderCap = policy ? Math.min(MAX_ORDER_NOTIONAL, Number(JSON.parse(policy.policyJson).maxOrderNotional)) : MAX_ORDER_NOTIONAL;
        await conn.reducers.recordDecisionInput({ id: ids.decisionId, runId, thesisId, quoteId: quote?.id ?? '',
          critiqueRefs: critiques.map(c => c.id).join(','), model: ask.model ?? 'fixture',
          promptVersion: PROMPT_VERSION, policyVersion: policyId, maxOrderNotional: String(orderCap) });
        input = conn.db.myDecisionInput.id.find(ids.decisionId)!;
      }
      const critiques = input.critiqueRefs.split(',').filter(Boolean).map(id => {
        const row = conn.db.myMessage.id.find(id);
        if (!row) throw new Error('Stored decision critique missing');
        return { id, body: row.body };
      });
      const quote = input.quoteId ? conn.db.myMarketObservation.id.find(input.quoteId) : undefined;
      const quoteView = quote ? observationView(quote) : undefined;
      const cap = Number(input.maxOrderNotional);
      const output = await accountedAsk(ask, conn, runId, ids.decisionId, ids.decisionId, signal)(CoordinatorOutput, COORDINATOR_SYSTEM,
        coordinatorPrompt(thesisView(thesis), critiques, quoteView, cap));

      // Validate the order before recording a trade decision, so an unusable order becomes a revise decision.
      let outcome = output.outcome;
      let rationale = output.rationale;
      let proposal: ReturnType<typeof toProposalArgs>;
      if (outcome === 'trade') {
        try {
          proposal = toProposalArgs(output, { proposalId: recordId('proposal.', thesisId), runId, thesis: thesisView(thesis) },
            quoteView, cap);
        } catch (error) {
          outcome = 'revise';
          rationale = `Proposed order was rejected before submission (${(error as Error).message}). ${rationale}`;
        }
      }
      rationale = clip(rationale);
      if (proposal) {
        const { id: proposalId, ...order } = proposal;
        await conn.reducers.recordTradeDecision({ decisionId: ids.decisionId, rationale, proposalId, ...order });
      } else {
        await conn.reducers.recordDecision(toDecisionArgs({ ...output, outcome, rationale }, { decisionId: ids.decisionId, thesisId }));
      }
      summary = { outcome, rationale };
    }
    const proposal = conn.db.myTradeProposal.id.find(recordId('proposal.', thesisId));
    if (summary.outcome === 'trade') {
      if (!proposal) throw new Error(`Trade decision ${ids.decisionId} has no durable proposal`);
      proposalNote = ` Proposed ${proposal.side} ${proposal.quantity} ${proposal.symbol} ${proposal.orderType}` +
        `${proposal.limitPrice ? ` @ ${proposal.limitPrice}` : ''} as ${proposal.id}, pending risk review.`;
    }
    await conn.reducers.postMessage({
      id: ids.messageId, runId, taskId: reviewTask.id, symbol: reviewTask.symbol, recipientRole: '',
      kind: 'decision', body: clip(`${summary.outcome} on ${thesisId}: ${summary.rationale}${proposalNote}`),
      evidenceRef: thesisId,
    });
    decideRetryAt.delete(ids.decisionId);
    console.log(`Decided ${thesisId}: ${summary.outcome}`);
  } catch (error) {
    if (isPermanent(error) && conn.db.myRun.id.find(runId)?.status === 'active' &&
        !conn.db.myDecision.id.find(ids.decisionId)) {
      const rationale = clip(`Coordinator could not produce a valid decision: ${String(error)}`);
      await conn.reducers.recordDecision({ id: ids.decisionId, thesisId, outcome: 'revise', rationale });
      await conn.reducers.postMessage({ id: ids.messageId, runId, taskId: reviewTask.id, symbol: reviewTask.symbol,
        recipientRole: '', kind: 'decision', body: clip(`revise on ${thesisId}: ${rationale}`), evidenceRef: thesisId });
      return;
    }
    decideRetryAt.set(ids.decisionId, Date.now() + DECIDE_RETRY_MS);
    throw error;
  }
}
