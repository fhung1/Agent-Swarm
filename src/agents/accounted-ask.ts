import { randomUUID } from 'node:crypto';
import type { DbConnection } from '../module_bindings/index.js';
import { recordId } from '../ids.js';
import { MAX_OUTPUT_TOKENS, type Ask, type AskUsage } from './llm.js';
import { DeferredWorkError } from '../work-errors.js';

export const PROMPT_VERSION = 'research-v3-sec-excerpts';
const INPUT_TOKEN_OVERHEAD = 16_000;
export function accountedAsk(ask: Ask, conn: DbConnection, runId: string, workId: string,
  refs: string, signal?: AbortSignal): Ask {
  const wrapped: Ask = async (schema, system, prompt) => {
    if (signal?.aborted || conn.db.myRun.id.find(runId)?.status !== 'active') throw new DeferredWorkError('Run paused or work aborted');
    const previous = [...conn.db.myInferenceAttempt.iter()].find(row =>
      row.workId === workId && row.status === 'completed' && row.inputRefs === refs && row.outputJson);
    if (previous) return schema.parse(JSON.parse(previous.outputJson));
    const id = recordId('inference.', `${workId}.${randomUUID()}`);
    // UTF-8 bytes upper-bound text tokens. Add separate input-format overhead and
    // reserve the provider's complete output allowance before calling it.
    const reservedInputTokens = Buffer.byteLength(system + prompt, 'utf8') + INPUT_TOKEN_OVERHEAD;
    const reservedOutputTokens = ask.maxOutputTokens ?? MAX_OUTPUT_TOKENS;
    await conn.reducers.beginInference({ id, runId, workId, model: ask.model ?? 'fixture',
      promptVersion: PROMPT_VERSION, inputRefs: refs, reservedInputTokens, reservedOutputTokens });
    let usage: AskUsage | undefined;
    let model = ask.model ?? 'fixture';
    try {
      const output = await ask(schema, system, prompt, { signal, onUsage: (tokens, actualModel) => {
        usage = tokens; if (actualModel) model = actualModel;
      } });
      if (!usage) throw new Error('Provider omitted usage; the full monetary reservation is retained');
      await conn.reducers.finishInference({ id, ...usage, usageKnown: true, succeeded: true, model, outputJson: JSON.stringify(output) });
      const audit = conn.db.myInferenceAttempt.id.find(id);
      if (audit?.status !== 'completed') throw new Error(`Inference was not accepted: ${audit?.failureReason || audit?.status || 'missing audit row'}`);
      if (signal?.aborted || conn.db.myRun.id.find(runId)?.status !== 'active') throw new DeferredWorkError('Run paused after inference');
      return output;
    } catch (error) {
      await conn.reducers.finishInference({ id, inputTokens: usage?.inputTokens ?? 0,
        cacheReadTokens: usage?.cacheReadTokens ?? 0, cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0, usageKnown: Boolean(usage), succeeded: false, model, outputJson: '' }).catch(() => {});
      throw error;
    }
  };
  wrapped.model = ask.model;
  wrapped.maxOutputTokens = ask.maxOutputTokens;
  return wrapped;
}
