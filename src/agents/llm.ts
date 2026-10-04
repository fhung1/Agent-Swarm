import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { z } from 'zod';

// One structured-output call: system instructions, a user prompt, and a zod schema for the reply.
// Model output is a proposal. Callers must still validate it against swarm state before calling a reducer.
export interface AskUsage { inputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; outputTokens: number }
export interface AskOptions { signal?: AbortSignal; onUsage?: (usage: AskUsage, model?: string) => void }
export type Ask = (<T extends z.ZodType>(schema: T, system: string, prompt: string, options?: AskOptions) => Promise<z.infer<T>>) & {
  model?: string; maxOutputTokens?: number;
};
export type Provider = 'claude' | 'codex';

const DEFAULT_MODELS: Record<Provider, string> = { claude: 'claude-opus-5-5', codex: 'gpt-5.3-codex' };
// Effort levels both providers accept.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = typeof EFFORTS[number];
export const MAX_OUTPUT_TOKENS = 16_000;

export function createAsker(provider: Provider, maxOutputTokens = MAX_OUTPUT_TOKENS): Ask {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > MAX_OUTPUT_TOKENS) {
    throw new Error(`maxOutputTokens must be an integer from 1 to ${MAX_OUTPUT_TOKENS}`);
  }
  const model = process.env.AGENT_MODEL ?? DEFAULT_MODELS[provider];
  const effort = (process.env.AGENT_EFFORT ?? 'high') as Effort;
  if (!EFFORTS.includes(effort)) throw new Error(`AGENT_EFFORT must be one of: ${EFFORTS.join(', ')}`);
  console.log(`Model brain: ${provider} (${model}, effort ${effort})`);
  const ask = provider === 'claude' ? claudeAsker(model, effort, maxOutputTokens) : codexAsker(model, effort, maxOutputTokens);
  ask.model = model;
  ask.maxOutputTokens = maxOutputTokens;
  return ask;
}

// Credentials: ANTHROPIC_API_KEY or an `ant auth login` profile.
function claudeAsker(model: string, effort: Effort, maxOutputTokens: number): Ask {
  let client: Anthropic | undefined;
  return async (schema, system, prompt, options) => {
    client ??= new Anthropic({ maxRetries: 0, timeout: 120_000 });
    const response = await client.beta.messages.parse({
      model,
      max_tokens: maxOutputTokens,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: [],
      output_config: { effort, format: betaZodOutputFormat(schema) },
      system,
      messages: [{ role: 'user', content: prompt }],
    }, { signal: options?.signal });
    const usage = response.usage;
    if (usage.input_tokens == null || usage.output_tokens == null) throw new Error('Provider omitted token usage');
    options?.onUsage?.({ inputTokens: usage.input_tokens, cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? 0, outputTokens: usage.output_tokens }, response.model);
    if (response.stop_reason === 'refusal') {
      throw new Error(`Model declined (${response.stop_details?.category ?? 'unspecified'})`);
    }
    if (response.stop_reason === 'max_tokens') throw new Error('Model output was truncated');
    if (response.parsed_output == null) throw new Error('Model output did not match the schema');
    return response.parsed_output;
  };
}

// Credentials: OPENAI_API_KEY. Plain inference with no tools, so prompt data cannot trigger commands or file reads.
function codexAsker(model: string, effort: Effort, maxOutputTokens: number): Ask {
  let client: OpenAI | undefined;
  return async (schema, system, prompt, options) => {
    client ??= new OpenAI({ maxRetries: 0, timeout: 120_000 });
    const response = await client.responses.parse({
      model,
      instructions: system,
      input: prompt,
      reasoning: { effort },
      max_output_tokens: maxOutputTokens,
      text: { format: zodTextFormat(schema, 'output') },
      store: false,
    }, { signal: options?.signal });
    if (response.usage) {
      const cached = response.usage.input_tokens_details.cached_tokens;
      const cacheWrite = response.usage.input_tokens_details.cache_write_tokens;
      const regularInput = response.usage.input_tokens - cached - cacheWrite;
      if (regularInput < 0) throw new Error('Provider returned inconsistent input token usage');
      options?.onUsage?.({ inputTokens: regularInput, cacheReadTokens: cached,
        cacheWriteTokens: cacheWrite, outputTokens: response.usage.output_tokens }, response.model);
    }
    if (response.status === 'incomplete') {
      throw new Error(`Model output was incomplete (${response.incomplete_details?.reason ?? 'unknown'})`);
    }
    for (const item of response.output) {
      if (item.type !== 'message') continue;
      const refusal = item.content.find(part => part.type === 'refusal');
      if (refusal) throw new Error(`Model declined: ${refusal.refusal}`);
    }
    if (response.output_parsed == null) throw new Error('Model output did not match the schema');
    return response.output_parsed as z.infer<typeof schema>;
  };
}
