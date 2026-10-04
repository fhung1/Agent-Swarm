import { Timestamp } from 'spacetimedb';
import { SenderError, t } from 'spacetimedb/server';
import spacetimedb from './schema';
import { requireId, requireOwner, requireRole, requireRun, requireText, requireEvidence, parseRefs, type Ctx } from './access';
import { validatePolicy, type RiskPolicy } from './risk';

export function configFor(ctx: Ctx, runId: string) {
  return ctx.db.runConfig.runId.find(runId) ?? ctx.db.runConfig.insert({ runId, policyId: '',
    maxInferences: 50, maxTokens: 1_000_000, maxConcurrent: 2, maxAttempts: 3, usedInferences: 0, usedTokens: 0,
    pricingVersion: '', maxSpendMicros: 0n, maxWorkerSpendMicros: 0n, usedSpendMicros: 0n });
}

const TOKEN_SCALE = 1_000_000n;
const U64_MAX = 18_446_744_073_709_551_615n;

function parseMicros(value: string, label: string): bigint {
  if (!/^(0|[1-9]\d{0,19})$/.test(value)) throw new SenderError(`${label} must be an unsigned micro-USD integer`);
  const parsed = BigInt(value);
  if (parsed > U64_MAX) throw new SenderError(`${label} is outside the supported range`);
  return parsed;
}

function costMicros(input: number, cacheRead: number, cacheWrite: number, output: number,
  price: { inputMicrosPerMillion: bigint; cacheReadMicrosPerMillion: bigint;
    cacheWriteMicrosPerMillion: bigint; outputMicrosPerMillion: bigint }): bigint {
  const numerator = BigInt(input) * price.inputMicrosPerMillion + BigInt(cacheRead) * price.cacheReadMicrosPerMillion +
    BigInt(cacheWrite) * price.cacheWriteMicrosPerMillion + BigInt(output) * price.outputMicrosPerMillion;
  const result = (numerator + TOKEN_SCALE - 1n) / TOKEN_SCALE;
  if (result > U64_MAX) throw new SenderError('Inference spend exceeds the supported range');
  return result;
}

function reserveMicros(input: number, output: number,
  price: { inputMicrosPerMillion: bigint; cacheReadMicrosPerMillion: bigint;
    cacheWriteMicrosPerMillion: bigint; outputMicrosPerMillion: bigint }): bigint {
  const inputRate = [price.inputMicrosPerMillion, price.cacheReadMicrosPerMillion, price.cacheWriteMicrosPerMillion]
    .reduce((max, rate) => rate > max ? rate : max, 0n);
  return costMicros(input, 0, 0, output, { ...price, inputMicrosPerMillion: inputRate });
}

function priceId(version: string, model: string): string { return `${version}:${model}`; }

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

// Price records are immutable snapshots supplied by the operator. A provider's
// published rates can change, so a new rate card must use a new version string.
export const configureModelPrice = spacetimedb.reducer({ version: t.string(), model: t.string(),
  inputMicrosPerMillion: t.string(), cacheReadMicrosPerMillion: t.string(),
  cacheWriteMicrosPerMillion: t.string(), outputMicrosPerMillion: t.string() }, (ctx, value) => {
  requireRole(ctx, ['operator']); requireText(value.version, 'Pricing version', 64); requireText(value.model, 'Model', 128);
  const row = { id: priceId(value.version, value.model), version: value.version, model: value.model,
    inputMicrosPerMillion: parseMicros(value.inputMicrosPerMillion, 'Input price'),
    cacheReadMicrosPerMillion: parseMicros(value.cacheReadMicrosPerMillion, 'Cache-read price'),
    cacheWriteMicrosPerMillion: parseMicros(value.cacheWriteMicrosPerMillion, 'Cache-write price'),
    outputMicrosPerMillion: parseMicros(value.outputMicrosPerMillion, 'Output price'), createdAt: ctx.timestamp };
  const previous = ctx.db.modelPrice.id.find(row.id);
  if (previous) {
    if (previous.version !== row.version || previous.model !== row.model ||
        previous.inputMicrosPerMillion !== row.inputMicrosPerMillion ||
        previous.cacheReadMicrosPerMillion !== row.cacheReadMicrosPerMillion ||
        previous.cacheWriteMicrosPerMillion !== row.cacheWriteMicrosPerMillion ||
        previous.outputMicrosPerMillion !== row.outputMicrosPerMillion) throw new SenderError('Pricing version is immutable');
    return;
  }
  ctx.db.modelPrice.insert(row);
});

export const configureRunSpend = spacetimedb.reducer({ runId: t.string(), pricingVersion: t.string(),
  maxSpendMicros: t.string(), maxWorkerSpendMicros: t.string() }, (ctx, value) => {
  requireRole(ctx, ['operator']); requireRun(ctx, value.runId); requireText(value.pricingVersion, 'Pricing version', 64);
  if (![...ctx.db.modelPrice.version.filter(value.pricingVersion)].length) throw new SenderError('Pricing version has no model prices');
  const maxSpendMicros = parseMicros(value.maxSpendMicros, 'Run spend ceiling');
  const maxWorkerSpendMicros = parseMicros(value.maxWorkerSpendMicros, 'Worker spend ceiling');
  const current = configFor(ctx, value.runId);
  if (maxSpendMicros && maxSpendMicros < current.usedSpendMicros) throw new SenderError('Run spend ceiling is below reserved or spent amount');
  const workerSpend = new Map<string, bigint>();
  for (const attempt of ctx.db.inferenceAttempt.runId.filter(value.runId)) {
    const id = attempt.actor.toHexString();
    workerSpend.set(id, (workerSpend.get(id) ?? 0n) + attempt.spendMicros);
  }
  if (maxWorkerSpendMicros && [...workerSpend.values()].some(used => used > maxWorkerSpendMicros)) {
    throw new SenderError('Worker spend ceiling is below reserved or spent amount');
  }
  ctx.db.runConfig.runId.update({ ...current, pricingVersion: value.pricingVersion, maxSpendMicros, maxWorkerSpendMicros });
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
  promptVersion: t.string(), inputRefs: t.string(), reservedInputTokens: t.u32(), reservedOutputTokens: t.u32() }, (ctx, value) => {
  requireRole(ctx, ['analyst', 'valuation', 'portfolio', 'skeptic', 'coordinator']); requireRun(ctx, value.runId); requireId(value.id); requireId(value.workId);
  requireText(value.model, 'Model', 128); requireText(value.promptVersion, 'Prompt version', 64);
  const reservedTokens = value.reservedInputTokens + value.reservedOutputTokens;
  if (value.inputRefs.length > 4096 || !value.reservedInputTokens || !value.reservedOutputTokens ||
      !Number.isSafeInteger(reservedTokens) || reservedTokens > 0xffff_ffff) throw new SenderError('Invalid inference reservation');
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
  if (!config.pricingVersion) throw new SenderError('Model price version is not configured');
  const price = ctx.db.modelPrice.id.find(priceId(config.pricingVersion, value.model));
  if (!price) throw new SenderError(`No model price for ${value.model} in version ${config.pricingVersion}`);
  const reservedSpendMicros = reserveMicros(value.reservedInputTokens, value.reservedOutputTokens, price);
  const attempts = [...ctx.db.inferenceAttempt.runId.filter(value.runId)];
  if (attempts.filter(a => a.workId === value.workId).length >= config.maxAttempts) throw new SenderError('Inference attempts exhausted');
  if (attempts.filter(a => a.status === 'running' && a.expiresAt.microsSinceUnixEpoch > ctx.timestamp.microsSinceUnixEpoch).length >= config.maxConcurrent) throw new SenderError('Inference capacity busy');
  if (config.usedInferences + 1 > config.maxInferences || config.usedTokens + reservedTokens > config.maxTokens) throw new SenderError('Inference budget exhausted');
  const workerSpend = attempts.filter(a => a.actor.equals(ctx.sender)).reduce((sum, a) => sum + a.spendMicros, 0n);
  if (config.maxSpendMicros && config.usedSpendMicros + reservedSpendMicros > config.maxSpendMicros) throw new SenderError('Run monetary budget exhausted');
  if (config.maxWorkerSpendMicros && workerSpend + reservedSpendMicros > config.maxWorkerSpendMicros) throw new SenderError('Worker monetary budget exhausted');
  if (config.usedSpendMicros + reservedSpendMicros > U64_MAX) throw new SenderError('Run spend counter overflow');
  ctx.db.runConfig.runId.update({ ...config, usedInferences: config.usedInferences + 1,
    usedTokens: config.usedTokens + reservedTokens, usedSpendMicros: config.usedSpendMicros + reservedSpendMicros });
  ctx.db.inferenceAttempt.insert({ ...value, reservedTokens, actor: ctx.sender, status: 'running', tokensUsed: reservedTokens,
    actualModel: '', outputJson: '', pricingVersion: config.pricingVersion, inputTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, outputTokens: 0, reservedSpendMicros, spendMicros: reservedSpendMicros, failureReason: '',
    startedAt: ctx.timestamp, expiresAt: new Timestamp(ctx.timestamp.microsSinceUnixEpoch + 180_000_000n) });
});
export const finishInference = spacetimedb.reducer({ id: t.string(), inputTokens: t.u32(), cacheReadTokens: t.u32(),
  cacheWriteTokens: t.u32(), outputTokens: t.u32(), usageKnown: t.bool(), succeeded: t.bool(), model: t.string(), outputJson: t.string() }, (ctx, value) => {
  requireRole(ctx, ['analyst', 'valuation', 'portfolio', 'skeptic', 'coordinator']);
  requireText(value.model, 'Actual model', 128);
  if (value.outputJson.length > 32768 || (value.succeeded && !value.outputJson)) throw new SenderError('Invalid inference output size');
  const attempt = ctx.db.inferenceAttempt.id.find(value.id);
  if (!attempt || !attempt.actor.equals(ctx.sender)) throw new SenderError('Inference not owned');
  if (attempt.status !== 'running') return;
  const actualTokens = value.inputTokens + value.cacheReadTokens + value.cacheWriteTokens + value.outputTokens;
  if (!Number.isSafeInteger(actualTokens) || actualTokens > 0xffff_ffff) throw new SenderError('Inference token count overflow');
  const config = configFor(ctx, attempt.runId);
  const actualPrice = ctx.db.modelPrice.id.find(priceId(attempt.pricingVersion, value.model));
  const requestPrice = ctx.db.modelPrice.id.find(priceId(attempt.pricingVersion, attempt.model));
  const price = actualPrice ?? requestPrice;
  if (!price) throw new SenderError('Recorded model price disappeared');
  const actualSpendMicros = costMicros(value.inputTokens, value.cacheReadTokens, value.cacheWriteTokens, value.outputTokens, price);
  const actualKnown = Boolean(actualPrice);
  const underReserved = value.usageKnown && (actualTokens > attempt.reservedTokens || actualSpendMicros > attempt.reservedSpendMicros);
  const unpricedActualModel = value.usageKnown && value.model !== attempt.model && !actualKnown;
  const failed = !value.succeeded || unpricedActualModel || underReserved;
  // A provider error or timeout can have incurred the full request charge. Keep
  // the reservation. Known usage that exceeds its reservation is recorded at
  // actual cost, the result is discarded, and the run pauses before more work.
  const settleActual = value.usageKnown && actualKnown && !unpricedActualModel;
  const settledTokens = settleActual ? actualTokens : attempt.reservedTokens;
  const settledSpendMicros = settleActual ? actualSpendMicros : attempt.reservedSpendMicros;
  const totalTokens = config.usedTokens - attempt.reservedTokens + settledTokens;
  const totalSpendMicros = config.usedSpendMicros - attempt.reservedSpendMicros + settledSpendMicros;
  if (totalTokens > 0xffff_ffff || totalSpendMicros > U64_MAX) throw new SenderError('Inference budget counter overflow');
  ctx.db.runConfig.runId.update({ ...config, usedTokens: totalTokens, usedSpendMicros: totalSpendMicros });
  if (underReserved || unpricedActualModel) {
    const run = ctx.db.run.id.find(attempt.runId)!;
    if (run.status === 'active') ctx.db.run.id.update({ ...run, status: 'paused' });
  }
  ctx.db.inferenceAttempt.id.update({ ...attempt, status: failed ? 'failed' : 'completed', tokensUsed: settledTokens,
    inputTokens: value.inputTokens, cacheReadTokens: value.cacheReadTokens, cacheWriteTokens: value.cacheWriteTokens,
    outputTokens: value.outputTokens, spendMicros: settledSpendMicros, actualModel: value.model,
    outputJson: failed ? '' : value.outputJson,
    failureReason: unpricedActualModel ? 'actual_model_unpriced' : underReserved ? 'usage_exceeded_reservation' : failed ? 'provider_call_uncertain' : '' });
});
