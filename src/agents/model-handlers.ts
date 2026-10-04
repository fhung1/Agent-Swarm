import type { DbConnection } from '../module_bindings/index.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadFilingExcerpts } from '../sec-excerpts.js';
import type { Fact, MarketObservation, Source, Task, Thesis } from '../module_bindings/types.js';
import { recordId } from '../ids.js';
import { accountedAsk, PROMPT_VERSION } from './accounted-ask.js';
import { isPermanent } from '../work-errors.js';
import type { Ask } from './llm.js';
import { selectEvidence, assertNarrativeCitations, assertPromptBudget } from './evidence.js';
import {
  ANALYST_SYSTEM, AnalystOutput, COORDINATOR_SYSTEM, CoordinatorOutput, SKEPTIC_SYSTEM, SkepticOutput,
  VALUATION_SYSTEM, ValuationOutput, PORTFOLIO_SYSTEM, PortfolioOutput, specialistPrompt, toSpecialistMessageArgs,
  analystPrompt, coordinatorPrompt, skepticPrompt, toCritiqueMessageArgs, toDecisionArgs, toProposalArgs, toPositionExitArgs,
  toPublishThesisArgs, type FactView, type ObservationView, type SourceView, type ThesisView, type TeamReportView,
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

const sourceView = (s: Source): SourceView => ({ id: s.id, symbol: s.symbol, kind: s.kind, uri: s.uri, asOf: s.asOf.toISOString(),
  qualitative: loadFilingExcerpts(s, process.env.SEC_ARTIFACT_DIR ?? join(homedir(), '.local', 'share', 'quant-swarm', 'artifacts', 'sec')),
});
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

export function teamReports(conn: DbConnection, thesisId: string): TeamReportView[] {
  return [...conn.db.myMessage.iter()]
    .filter(m => (m.kind === 'valuation' || m.kind === 'portfolio') && m.evidenceRef === thesisId)
    .map(m => ({ id: m.id, kind: m.kind as 'valuation' | 'portfolio', body: m.body }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function modelSpecialistReport(ask: Ask, conn: DbConnection, task: Task, runId: string,
  signal?: AbortSignal): Promise<Outcome> {
  const kind = task.kind as 'valuation' | 'portfolio';
  if (kind !== 'valuation' && kind !== 'portfolio') throw new Error('Unknown specialist kind');
  const thesisId = conn.db.myTask.id.find(task.dependsOn)?.result ?? '';
  const thesis = conn.db.myThesis.id.find(thesisId);
  if (!thesis || thesis.runId !== runId || thesis.symbol !== task.symbol) return { ok: false, text: 'Specialist thesis missing or mismatched' };
  const messageId = recordId('', task.id, '.report');
  if (conn.db.myMessage.id.find(messageId)) return { ok: true, text: messageId };
  const { sources, facts, observations, omitted, allowedIds, refs } = evidenceFor(conn, runId, task.symbol);
  let context = '';
  let contextRef = '';
  if (kind === 'portfolio') {
    const policyId = conn.db.myRunConfig.runId.find(runId)?.policyId ?? '';
    const policy = policyId ? conn.db.myRiskPolicy.id.find(policyId) : undefined;
    const snapshot = policy ? [...conn.db.myAccountSnapshot.iter()]
      .filter(row => row.accountId === policy.accountId)
      .sort((a, b) => Number(b.capturedAt.microsSinceUnixEpoch - a.capturedAt.microsSinceUnixEpoch))[0] : undefined;
    const ageMs = snapshot ? Date.now() - Number(snapshot.capturedAt.microsSinceUnixEpoch / 1000n) : Infinity;
    if (!policy || !snapshot || ageMs < 0 || ageMs > 15 * 60_000) {
      const args = toSpecialistMessageArgs(kind, { status: 'insufficient', exposure: 'Current account snapshot unavailable or stale',
        liquidity: 'Unavailable', concentration: 'Unavailable', recommendation: 'No trade recommendation without fresh account state',
        evidence_ids: [] }, { messageId, runId, taskId: task.id, symbol: task.symbol, thesisId }, allowedIds);
      await conn.reducers.postMessage(args);
      return { ok: true, text: messageId };
    }
    contextRef = snapshot.id;
    context = `<paper_account_snapshot id="${snapshot.id}" as_of="${snapshot.capturedAt.toISOString()}">` +
      `Status: ${snapshot.accountStatus}; cash: ${snapshot.cash}; buying power: ${snapshot.buyingPower}; equity: ${snapshot.equity}; daily P&L vs prior close: ${snapshot.dailyPnl ?? 'unavailable'}.\n` +
      `Positions: ${clip(snapshot.positionsJson, 2500)}\nOpen orders: ${clip(snapshot.openOrdersJson, 2500)}\n` +
      `Policy: ${clip(policy.policyJson, 2500)}</paper_account_snapshot>`;
  }
  const system = kind === 'valuation' ? VALUATION_SYSTEM : PORTFOLIO_SYSTEM;
  const prompt = specialistPrompt(thesisView(thesis), sources, facts, observations, omitted, context);
  assertPromptBudget(system, prompt);
  const inputRefs = [thesisId, refs].filter(Boolean).join(',');
  const output = kind === 'valuation'
    ? await accountedAsk(ask, conn, runId, task.id, inputRefs, signal)(ValuationOutput, system, prompt)
    : await accountedAsk(ask, conn, runId, task.id, inputRefs, signal)(PortfolioOutput, system, prompt);
  const args = toSpecialistMessageArgs(kind, output, { messageId, runId, taskId: task.id, symbol: task.symbol, thesisId },
    allowedIds, contextRef);
  await conn.reducers.postMessage(args);
  return { ok: true, text: messageId };
}

export async function modelWriteThesis(ask: Ask, conn: DbConnection, task: Task, runId: string, signal?: AbortSignal): Promise<Outcome> {
  const thesisId = recordId('thesis.', task.id);
  // A resumed task may already have published its thesis; do not pay for a second model call.
  if (!conn.db.myThesis.id.find(thesisId)) {
    const { sources, facts, observations, omitted, allowedIds: allowed, refs, narrativeRefs } = evidenceFor(conn, runId, task.symbol);
    if (sources.length === 0) return { ok: false, text: `No stored sources for ${task.symbol} in run ${runId}` };
    const priorId = task.kind === 'position_review' ? conn.db.myTask.id.find(task.dependsOn)?.result ?? '' : '';
    const prior = priorId ? conn.db.myThesis.id.find(priorId) : undefined;
    const reviewContext = prior ? `\nOriginal thesis ${prior.id}: Bull: ${clip(prior.bullCase, 500)}; Bear: ${clip(prior.bearCase, 500)}; ` +
      `Assumptions: ${clip(prior.assumptions, 500)}; Invalidation: ${clip(prior.invalidation, 500)}.` : '';
    const prompt = analystPrompt(task.symbol, task.objective + reviewContext, sources, facts, observations, omitted);
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
    const reports = teamReports(conn, thesisId);
    const prompt = skepticPrompt(thesisView(thesis), sources, facts, observations, omitted, reports);
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
  required: { valuation: boolean; portfolio: boolean } = { valuation: false, portfolio: false },
): Promise<void> {
  if ((decideRetryAt.get(ids.decisionId) ?? 0) > Date.now()) return;
  try {
    const thesis = conn.db.myThesis.id.find(thesisId)!;
    const positionTask = conn.db.myTask.id.find(thesis.taskId);
    const exitOnly = positionTask?.kind === 'position_review';
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
          .filter(m => m.runId === runId && ['challenge', 'valuation', 'portfolio'].includes(m.kind) && m.evidenceRef === thesisId)
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
        return { id, kind: row.kind, body: row.body };
      });
      const reports = critiques.filter(c => c.kind === 'valuation' || c.kind === 'portfolio') as TeamReportView[];
      const reviews = critiques.filter(c => c.kind === 'challenge');
      const quote = input.quoteId ? conn.db.myMarketObservation.id.find(input.quoteId) : undefined;
      const quoteView = quote ? observationView(quote) : undefined;
      const cap = Number(input.maxOrderNotional);
      const output = await accountedAsk(ask, conn, runId, ids.decisionId, ids.decisionId, signal)(CoordinatorOutput, COORDINATOR_SYSTEM,
        coordinatorPrompt(thesisView(thesis), reviews, quoteView, cap, reports, exitOnly, exitOnly ? positionTask!.objective : ''));

      // Validate the order before recording a trade decision, so an unusable order becomes a revise decision.
      let outcome = output.outcome;
      let rationale = output.rationale;
      let proposal: ReturnType<typeof toProposalArgs>;
      if (outcome === 'trade') {
        try {
          for (const kind of ['valuation', 'portfolio'] as const) {
            if (required[kind] && !reports.some(report => report.kind === kind)) throw new Error(`Required ${kind} report is missing`);
          }
          if (reports.some(report => JSON.parse(report.body).status !== 'ready')) throw new Error('Specialist report is insufficient');
          const args = { proposalId: recordId('proposal.', thesisId), runId, thesis: thesisView(thesis) };
          proposal = exitOnly ? toPositionExitArgs(output, args, quoteView, cap)
            : toProposalArgs(output, args, quoteView, cap);
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
