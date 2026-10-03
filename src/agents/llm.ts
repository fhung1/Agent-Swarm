import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { z } from 'zod';

// One structured-output call: system instructions, a user prompt, and a zod schema for the reply.
// Model output is a proposal. Callers must still validate it against swarm state before calling a reducer.
export type Ask = <T extends z.ZodType>(schema: T, system: string, prompt: string) => Promise<z.infer<T>>;
export type Provider = 'claude' | 'codex';

const DEFAULT_MODELS: Record<Provider, string> = { claude: 'claude-opus-5-5', codex: 'gpt-5.3-codex' };
// Effort levels both providers accept.
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type Effort = typeof EFFORTS[number];
const MAX_OUTPUT_TOKENS = 16_000;

export function createAsker(provider: Provider): Ask {
  const model = process.env.AGENT_MODEL ?? DEFAULT_MODELS[provider];
  const effort = (process.env.AGENT_EFFORT ?? 'high') as Effort;
  if (!EFFORTS.includes(effort)) throw new Error(`AGENT_EFFORT must be one of: ${EFFORTS.join(', ')}`);
  console.log(`Model brain: ${provider} (${model}, effort ${effort})`);
  return provider === 'claude' ? claudeAsker(model, effort) : codexAsker(model, effort);
}

// Credentials: ANTHROPIC_API_KEY or an `ant auth login` profile.
function claudeAsker(model: string, effort: Effort): Ask {
  let client: Anthropic | undefined;
  return async (schema, system, prompt) => {
    client ??= new Anthropic();
    const response = await client.beta.messages.parse({
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort, format: betaZodOutputFormat(schema) },
      system,
      messages: [{ role: 'user', content: prompt }],
    });
    if (response.stop_reason === 'refusal') {
      throw new Error(`Model declined (${response.stop_details?.category ?? 'unspecified'})`);
    }
    if (response.stop_reason === 'max_tokens') throw new Error('Model output was truncated');
    if (response.parsed_output == null) throw new Error('Model output did not match the schema');
    return response.parsed_output;
  };
}

// Credentials: OPENAI_API_KEY. Plain inference with no tools, so prompt data cannot trigger commands or file reads.
function codexAsker(model: string, effort: Effort): Ask {
  let client: OpenAI | undefined;
  return async (schema, system, prompt) => {
    client ??= new OpenAI();
    const response = await client.responses.parse({
      model,
      instructions: system,
      input: prompt,
      reasoning: { effort },
      max_output_tokens: MAX_OUTPUT_TOKENS,
      text: { format: zodTextFormat(schema, 'output') },
      store: false,
    });
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
