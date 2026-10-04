import { Timestamp } from 'spacetimedb';
import { SenderError, t } from 'spacetimedb/server';
import spacetimedb from './schema';
import { requireId, requireOwner, requireRole, requireRun, requireText, requireEvidence, parseRefs, type Ctx } from './access';
import { validatePolicy, type RiskPolicy } from './risk';

export function configFor(ctx: Ctx, runId: string) {
  return ctx.db.runConfig.runId.find(runId) ?? ctx.db.runConfig.insert({ runId, policyId: '',
    maxInferences: 50, maxTokens: 1_000_000, maxConcurrent: 2, maxAttempts: 3, usedInferences: 0, usedTokens: 0 });
}

export const grantRunAccess = spacetimedb.reducer({ identity: t.identity(), runId: t.string() }, (ctx, value) => {
  requireOwner(ctx); requireId(value.runId);
  if (!ctx.db.run.id.find(value.runId) || !ctx.db.agent.identity.find(value.identity)) throw new SenderError('Run/agent not found');
  const id = `${value.identity.toHexString()}:${value.runId}`;
  if (!ctx.db.runAccess.id.find(id)) ctx.db.runAccess.insert({ id, ...value });
});
export const revokeRunAccess = spacetimedb.reducer({ identity: t.identity(), runId: t.string() }, (ctx, value) => {
  requireOwner(ctx); ctx.db.runAccess.id.delete(`${value.identity.toHexString()}:${value.runId}`);
});
export const grantAccountAccess = spacetimedb.reducer({ identity: t.identity(), accountId: t.string() }, (ctx, value) => {
  requireOwner(ctx); requireText(value.accountId, 'Account ID', 128);
  if (!ctx.db.agent.identity.find(value.identity)) throw new SenderError('Agent not found');
  const id = `${value.identity.toHexString()}:${value.accountId}`;
  if (!ctx.db.accountAccess.id.find(id)) ctx.db.accountAccess.insert({ id, ...value });
});
export const revokeAccountAccess = spacetimedb.reducer({ identity: t.identity(), accountId: t.string() }, (ctx, value) => {
  requireOwner(ctx); ctx.db.accountAccess.id.delete(`${value.identity.toHexString()}:${value.accountId}`);
});

export const configureRunLimits = spacetimedb.reducer({ runId: t.string(), maxInferences: t.u32(), maxTokens: t.u32(),
  maxConcurrent: t.u32(), maxAttempts: t.u32() }, (ctx, value) => {
  requireRole(ctx, ['operator']); requireRun(ctx, value.runId);
  if (!value.maxInferences || value.maxInferences > 10_000 || !value.maxTokens || value.maxTokens > 100_000_000 ||
      !value.maxConcurrent || value.maxConcurrent > 20 || !value.maxAttempts || value.maxAttempts > 10) throw new SenderError('Invalid run limits');
  const current = configFor(ctx, value.runId);
  if (value.maxInferences < current.usedInferences || value.maxTokens < current.usedTokens) throw new SenderError('Limits below consumed budget');
  ctx.db.runConfig.runId.update({ ...current, ...value });
});

export const addRiskPolicy = spacetimedb.reducer({ id: t.string(), runId: t.string(), accountId: t.string(), policyJson: t.string() }, (ctx, value) => {
  requireRole(ctx, ['operator']); requireId(value.id); requireRun(ctx, value.runId);
  requireText(value.accountId, 'Account ID', 128); requireText(value.policyJson, 'Policy JSON');
  const policy = JSON.parse(value.policyJson) as RiskPolicy;
  validatePolicy(policy);
  if (policy.version !== value.id) throw new SenderError('Policy version must match immutable policy ID');
  const existing = ctx.db.riskPolicy.id.find(value.id);
  if (existing) {
    if (existing.runId !== value.runId || existing.accountId !== value.accountId || existing.policyJson !== value.policyJson) throw new SenderError('Policy ID already used');
  } else ctx.db.riskPolicy.insert({ ...value, createdAt: ctx.timestamp });
  const current = configFor(ctx, value.runId);
  ctx.db.runConfig.runId.update({ ...current, policyId: value.id });
});

export const recordMarketClock = spacetimedb.reducer({ accountId: t.string(), isOpen: t.bool(), asOf: t.timestamp() }, (ctx, value) => {
  requireRole(ctx, ['market_data', 'risk']);
  if (!ctx.db.accountAccess.id.find(`${ctx.sender.toHexString()}:${value.accountId}`)) throw new SenderError('Account access required');
  const age = ctx.timestamp.microsSinceUnixEpoch - value.asOf.microsSinceUnixEpoch;
  if (age < 0n || age > 60_000_000n) throw new SenderError('Clock is stale or future dated');
  const previous = ctx.db.marketClock.accountId.find(value.accountId);
  if (previous && previous.asOf.microsSinceUnixEpoch > value.asOf.microsSinceUnixEpoch) throw new SenderError('Clock cannot regress');
  const row = { ...value, capturedAt: ctx.timestamp };
  if (previous) ctx.db.marketClock.accountId.update(row); else ctx.db.marketClock.insert(row);
});

export const recordDecisionInput = spacetimedb.reducer({ id: t.string(), runId: t.string(), thesisId: t.string(), quoteId: t.string(),
  critiqueRefs: t.string(), model: t.string(), promptVersion: t.string(), policyVersion: t.string(), maxOrderNotional: t.string() }, (ctx, value) => {
  requireRole(ctx, ['coordinator']); requireRun(ctx, value.runId); requireId(value.id);
  const thesis = ctx.db.thesis.id.find(value.thesisId);
  if (!thesis || thesis.runId !== value.runId) throw new SenderError('Thesis/run mismatch');
  requireText(value.model, 'Model', 128); requireText(value.promptVersion, 'Prompt version', 64);
  if (value.policyVersion.length > 128) throw new SenderError('Policy version too long');
  const cap = Number(value.maxOrderNotional);
  if (!Number.isFinite(cap) || cap <= 0) throw new SenderError('Invalid order cap');
  if (value.quoteId) requireEvidence(ctx, [value.quoteId], thesis.symbol, ['market_observation'], value.runId);
  for (const id of parseRefs(value.critiqueRefs)) {
    const critique = ctx.db.message.id.find(id);
    if (!critique || critique.runId !== value.runId || critique.symbol !== thesis.symbol ||
        !['challenge', 'valuation', 'portfolio'].includes(critique.kind) || critique.evidenceRef !== value.thesisId) throw new SenderError('Invalid critique');
  }
  const previous = ctx.db.decisionInput.id.find(value.id);
  if (previous) {
    for (const key of Object.keys(value) as (keyof typeof value)[]) if (previous[key] !== value[key]) throw new SenderError('Decision inputs immutable');
    return;
  }
  const configuredPolicy = ctx.db.runConfig.runId.find(value.runId)?.policyId ?? '';
  if (value.policyVersion !== configuredPolicy) throw new SenderError('Decision policy is not current');
  if (configuredPolicy) {
    const policy = JSON.parse(ctx.db.riskPolicy.id.find(configuredPolicy)!.policyJson) as RiskPolicy;
    if (cap > policy.maxOrderNotional) throw new SenderError('Decision order cap exceeds policy');
  }
  ctx.db.decisionInput.insert({ ...value, capturedAt: ctx.timestamp });
});

export const beginInference = spacetimedb.reducer({ id: t.string(), runId: t.string(), workId: t.string(), model: t.string(),
  promptVersion: t.string(), inputRefs: t.string(), reservedTokens: t.u32() }, (ctx, value) => {
  requireRole(ctx, ['analyst', 'valuation', 'portfolio', 'skeptic', 'coordinator']); requireRun(ctx, value.runId); requireId(value.id); requireId(value.workId);
  requireText(value.model, 'Model', 128); requireText(value.promptVersion, 'Prompt version', 64);
  if (value.inputRefs.length > 4096 || value.reservedTokens < 16_000) throw new SenderError('Invalid inference reservation');
  if (ctx.db.inferenceAttempt.id.find(value.id)) throw new SenderError('Inference attempt exists');
  const task = ctx.db.task.id.find(value.workId);
  const input = ctx.db.decisionInput.id.find(value.workId);
  if (task) {
    if (task.runId !== value.runId || task.status !== 'claimed' || !task.assignee?.equals(ctx.sender) ||
        !task.leaseUntil || task.leaseUntil.microsSinceUnixEpoch <= ctx.timestamp.microsSinceUnixEpoch) throw new SenderError('Task not owned');
    requireEvidence(ctx, parseRefs(value.inputRefs), task.symbol, ['source', 'fact', 'thesis', 'market_observation'], value.runId);
  } else {
    if (!input || input.runId !== value.runId || ctx.db.agent.identity.find(ctx.sender)?.role !== 'coordinator' || value.inputRefs !== input.id) throw new SenderError('Inference work not authorized');
    if (input.model !== value.model || input.promptVersion !== value.promptVersion) throw new SenderError('Inference differs from frozen decision configuration');
  }
  const config = configFor(ctx, value.runId);
  const attempts = [...ctx.db.inferenceAttempt.runId.filter(value.runId)];
  if (attempts.filter(a => a.workId === value.workId).length >= config.maxAttempts) throw new SenderError('Inference attempts exhausted');
  if (attempts.filter(a => a.status === 'running' && a.expiresAt.microsSinceUnixEpoch > ctx.timestamp.microsSinceUnixEpoch).length >= config.maxConcurrent) throw new SenderError('Inference capacity busy');
  if (config.usedInferences + 1 > config.maxInferences || config.usedTokens + value.reservedTokens > config.maxTokens) throw new SenderError('Inference budget exhausted');
  ctx.db.runConfig.runId.update({ ...config, usedInferences: config.usedInferences + 1, usedTokens: config.usedTokens + value.reservedTokens });
  ctx.db.inferenceAttempt.insert({ ...value, actor: ctx.sender, status: 'running', tokensUsed: value.reservedTokens,
    actualModel: '', outputJson: '', startedAt: ctx.timestamp, expiresAt: new Timestamp(ctx.timestamp.microsSinceUnixEpoch + 180_000_000n) });
});
export const finishInference = spacetimedb.reducer({ id: t.string(), tokensUsed: t.u32(), succeeded: t.bool(), model: t.string(), outputJson: t.string() }, (ctx, value) => {
  requireRole(ctx, ['analyst', 'valuation', 'portfolio', 'skeptic', 'coordinator']);
  requireText(value.model, 'Actual model', 128);
  if (value.outputJson.length > 32768 || (value.succeeded && !value.outputJson)) throw new SenderError('Invalid inference output size');
  const attempt = ctx.db.inferenceAttempt.id.find(value.id);
  if (!attempt || !attempt.actor.equals(ctx.sender)) throw new SenderError('Inference not owned');
  if (attempt.status !== 'running') return;
  // On an uncertain provider failure retain the whole reservation, avoiding unaccounted spend.
  const tokensUsed = value.succeeded ? value.tokensUsed : attempt.reservedTokens;
  const config = configFor(ctx, attempt.runId);
  const total = config.usedTokens - attempt.reservedTokens + tokensUsed;
  if (total > 0xffffffff) throw new SenderError('Token count overflow');
  ctx.db.runConfig.runId.update({ ...config, usedTokens: total });
  ctx.db.inferenceAttempt.id.update({ ...attempt, status: value.succeeded ? 'completed' : 'failed', tokensUsed, actualModel: value.model, outputJson: value.succeeded ? value.outputJson : '' });
});
