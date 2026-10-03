import { randomUUID } from 'node:crypto';
import type { DbConnection } from '../module_bindings/index.js';
import { recordId } from '../ids.js';
import type { Ask } from './llm.js';
import { DeferredWorkError } from '../work-errors.js';

export const PROMPT_VERSION = 'research-v2';
export function accountedAsk(ask: Ask, conn: DbConnection, runId: string, workId: string,
  refs: string, signal?: AbortSignal): Ask {
  const wrapped: Ask = async (schema, system, prompt) => {
    if (signal?.aborted || conn.db.myRun.id.find(runId)?.status !== 'active') throw new DeferredWorkError('Run paused or work aborted');
    const previous = [...conn.db.myInferenceAttempt.iter()].find(row =>
      row.workId === workId && row.status === 'completed' && row.inputRefs === refs && row.outputJson);
    if (previous) return schema.parse(JSON.parse(previous.outputJson));
    const id = recordId('inference.', `${workId}.${randomUUID()}`);
    // UTF-8 bytes upper-bound text tokens; reserve output and structured-format overhead too.
    const reservedTokens = Buffer.byteLength(system + prompt, 'utf8') + 32_000;
    await conn.reducers.beginInference({ id, runId, workId, model: ask.model ?? 'fixture',
      promptVersion: PROMPT_VERSION, inputRefs: refs, reservedTokens });
    let tokensUsed = reservedTokens;
    let model = ask.model ?? 'fixture';
    try {
      const output = await ask(schema, system, prompt, { signal, onUsage: (tokens, actualModel) => {
        tokensUsed = tokens; if (actualModel) model = actualModel;
      } });
      await conn.reducers.finishInference({ id, tokensUsed, succeeded: true, model, outputJson: JSON.stringify(output) });
      if (signal?.aborted || conn.db.myRun.id.find(runId)?.status !== 'active') throw new DeferredWorkError('Run paused after inference');
      return output;
    } catch (error) {
      await conn.reducers.finishInference({ id, tokensUsed, succeeded: false, model, outputJson: '' }).catch(() => {});
      throw error;
    }
  };
  wrapped.model = ask.model;
  return wrapped;
}
