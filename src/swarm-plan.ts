import { z } from 'zod';

// Pure planning for the local swarm supervisor (scripts/swarm.ts): validates the swarm config, expands per-role agent
// counts into named processes, and lists the owner/operator commands each process needs. No I/O here.

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SYMBOL = /^[A-Z][A-Z0-9.-]{0,15}$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const brain = z.enum(['rules', 'claude', 'codex']);
const effort = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);

const modelAgent = (max: number) => z.object({
  count: z.number().int().min(0).max(max),
  brain: brain.default('rules'),
  model: z.string().min(1).max(128).optional(),
  effort: effort.optional(),
}).strict();
const singleton = z.object({ count: z.number().int().min(0).max(1) }).strict();

// Analysts and skeptics compete for tasks through atomic claims, so any number can run. The coordinator,
// risk broker, and executor each act on the whole run or account; a second copy would duplicate model
// decisions, invalidate the other's risk snapshots, or race on the same broker orders, so each is limited to one.
export const SwarmConfigSchema = z.object({
  runId: z.string().regex(ID),
  goal: z.string().min(1).max(4096).default('Paper trading research run'),
  namePrefix: z.string().regex(/^[a-z0-9][a-z0-9-]{0,23}$/).default('swarm'),
  server: z.string().min(1).default('local'),
  database: z.string().min(1).default('quant-swarm'),
  host: z.string().regex(/^wss?:\/\//).default('ws://localhost:3000'),
  // Alpaca paper account ID; empty means "detect from ALPACA_API_KEY/ALPACA_API_SECRET" at grant time.
  accountId: z.string().max(128).default(''),
  agents: z.object({
    coordinator: modelAgent(1).default({ count: 1, brain: 'rules' }),
    analyst: modelAgent(20).default({ count: 1, brain: 'rules' }),
    skeptic: modelAgent(20).default({ count: 1, brain: 'rules' }),
    risk: singleton.default({ count: 0 }),
    executor: singleton.default({ count: 0 }),
  }).strict(),
  maxOrderNotional: z.number().positive().optional(),
  limits: z.object({
    maxInferences: z.number().int().min(1).max(10_000),
    maxTokens: z.number().int().min(1).max(100_000_000),
    maxConcurrent: z.number().int().min(1).max(20),
    maxAttempts: z.number().int().min(1).max(10),
  }).strict().optional(),
  riskPolicyFile: z.string().min(1).default('config/risk-policy.json'),
  feed: z.enum(['sip', 'iex', 'delayed_sip', 'boats', 'overnight', 'otc']).default('iex'),
  // Periodic quote snapshots for analysts and coordinators; omit to disable.
  marketData: z.object({
    everySeconds: z.number().int().min(30).max(86_400),
    symbols: z.array(z.string().regex(SYMBOL)).min(1).max(50),
  }).strict().optional(),
  // Seeds analyst thesis tasks after loading evidence; schedule opts into recurring bounded cycles.
  research: z.object({
    symbols: z.array(z.string().regex(SYMBOL)).min(1).max(50),
    evidence: z.enum(['fixture', 'sec', 'none']).default('fixture'),
    objective: z.string().min(1).max(1000).default('Assess the stored evidence and write a balanced, sourced thesis'),
    schedule: z.object({
      everySeconds: z.number().int().min(60).max(31_536_000),
      maxCycles: z.number().int().min(1).max(1000),
      maxPendingCycles: z.number().int().min(1).max(10).default(1),
    }).strict().optional(),
  }).strict().optional(),
}).strict();

export type SwarmConfig = z.infer<typeof SwarmConfigSchema>;
export type Role = 'coordinator' | 'analyst' | 'skeptic' | 'risk' | 'executor' | 'market_data' | 'ingestor';

export interface ProcessSpec {
  name: string;
  role: Role;
  script: string;              // bundle under dist/
  args: string[];
  env: Record<string, string>; // non-secret settings only
  secrets: string[];           // environment variable names the process needs; values come from the caller's shell
  periodicSeconds?: number;    // run repeatedly instead of continuously
  oneShot?: boolean;           // run once during startup
  accountAccess: boolean;
  tokenFileEnv: 'AGENT_TOKEN_FILE' | 'SPACETIMEDB_TOKEN_FILE';
}

export function parseSwarmConfig(json: string): SwarmConfig {
  const config = SwarmConfigSchema.parse(JSON.parse(json));
  if (config.agents.coordinator.count === 0 && config.agents.analyst.count + config.agents.skeptic.count > 0) {
    throw new Error('Analysts and skeptics need a coordinator to queue reviews and record decisions');
  }
  if (config.agents.executor.count && !config.agents.risk.count) {
    throw new Error('An executor needs the risk broker: only fresh risk passes can be submitted');
  }
  if (config.research?.schedule) {
    if (!config.limits) throw new Error('Scheduled research requires explicit durable run limits');
    if (config.research.evidence === 'none') throw new Error('Scheduled research requires fresh evidence ingestion');
    if (new Set(config.research.symbols).size !== config.research.symbols.length) throw new Error('Duplicate scheduled research symbols');
    if (!config.agents.analyst.count || !config.agents.skeptic.count || !config.agents.coordinator.count) {
      throw new Error('Scheduled research requires analyst, skeptic and coordinator workers');
    }
    if (config.research.evidence === 'sec' && config.runId.length > 64) throw new Error('SEC ingestion requires a run ID of at most 64 characters');
  }
  return config;
}

function brainSecrets(choice: string): string[] {
  if (choice === 'codex') return ['OPENAI_API_KEY'];
  // Claude also accepts an `ant auth login` profile, so its key is checked as a warning, not required here.
  return [];
}

export function planProcesses(config: SwarmConfig): ProcessSpec[] {
  const processes: ProcessSpec[] = [];
  const base = { SPACETIMEDB_HOST: config.host, SPACETIMEDB_DB_NAME: config.database };
  for (const role of ['coordinator', 'analyst', 'skeptic'] as const) {
    const spec = config.agents[role];
    for (let i = 1; i <= spec.count; i++) {
      processes.push({
        name: `${config.namePrefix}-${role}-${i}`, role, script: 'worker.js', args: [],
        env: {
          ...base, RUN_ID: config.runId, AUTO_CLAIM: '1', AGENT_BRAIN: spec.brain,
          ...(spec.model ? { AGENT_MODEL: spec.model } : {}), ...(spec.effort ? { AGENT_EFFORT: spec.effort } : {}),
          ...(role === 'coordinator' && config.maxOrderNotional ? { MAX_ORDER_NOTIONAL: String(config.maxOrderNotional) } : {}),
        },
        secrets: brainSecrets(spec.brain), accountAccess: false, tokenFileEnv: 'AGENT_TOKEN_FILE',
      });
    }
  }
  if (config.agents.risk.count) processes.push({
    name: `${config.namePrefix}-risk-1`, role: 'risk', script: 'risk-worker.js', args: [],
    env: { ...base, ALPACA_DATA_FEED: config.feed }, secrets: ['ALPACA_API_KEY', 'ALPACA_API_SECRET'],
    accountAccess: true, tokenFileEnv: 'AGENT_TOKEN_FILE',
  });
  if (config.agents.executor.count) processes.push({
    name: `${config.namePrefix}-executor-1`, role: 'executor', script: 'executor.js', args: [],
    env: base, secrets: ['ALPACA_API_KEY', 'ALPACA_API_SECRET'], accountAccess: true, tokenFileEnv: 'AGENT_TOKEN_FILE',
  });
  if (config.marketData) processes.push({
    name: `${config.namePrefix}-market-data`, role: 'market_data', script: 'alpaca-paper-adapter.js', args: [],
    env: { ...base, ALPACA_DATA_FEED: config.feed, ALPACA_SYMBOLS: config.marketData.symbols.join(',') },
    secrets: ['ALPACA_API_KEY', 'ALPACA_API_SECRET'], periodicSeconds: config.marketData.everySeconds,
    accountAccess: true, tokenFileEnv: 'SPACETIMEDB_TOKEN_FILE',
  });
  if (config.research && config.research.evidence !== 'none') processes.push({
    name: `${config.namePrefix}-${config.research.evidence}-ingestor`, role: 'ingestor',
    script: config.research.evidence === 'sec' ? 'sec-ingestor.js' : 'fixture-ingestor.js', args: [],
    // SEC fair-access policy requires a contact User-Agent; it is personal, so it stays in the caller's environment.
    env: { ...base, RUN_ID: config.runId }, secrets: config.research.evidence === 'sec' ? ['SEC_USER_AGENT'] : [],
    oneShot: true, accountAccess: false, tokenFileEnv: 'SPACETIMEDB_TOKEN_FILE',
  });
  for (const p of processes) {
    if (!NAME.test(p.name)) throw new Error(`Process name ${p.name} is invalid`);
    for (const s of p.secrets) if (!ENV_NAME.test(s)) throw new Error(`Invalid secret name ${s}`);
  }
  return processes;
}

// Policy IDs are immutable and tied to one run, so the shipped policy's version is made run-specific.
export function runPolicy(policyJson: string, runId: string): { id: string; json: string } {
  const policy = JSON.parse(policyJson) as { version: string };
  const id = `${policy.version}.${runId}`.slice(0, 128);
  return { id, json: JSON.stringify({ ...policy, version: id }) };
}

export type Command = { reducer: string; args: (string | number)[]; note: string };

export function researchSymbolEnv(ingestor: ProcessSpec, symbol: string): Record<string, string> {
  if (!SYMBOL.test(symbol)) throw new Error('Invalid research symbol');
  return ingestor.script === 'sec-ingestor.js' ? { SYMBOLS: symbol } : { SYMBOL: symbol };
}

export function scopedProcessEnv(process:ProcessSpec,base:Record<string,string|undefined>):Record<string,string|undefined>{
  const env={...base};
  for(const key of ['ALPACA_API_KEY','ALPACA_API_SECRET','OPENAI_API_KEY','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','SEC_USER_AGENT']){
    if(!process.secrets.includes(key)&&!(key==='ANTHROPIC_AUTH_TOKEN'&&process.secrets.includes('ANTHROPIC_API_KEY')))delete env[key];
  }
  return env;
}

// Owner/operator commands, in order. Each is safe to repeat (grants and identical policies are no-ops); the run is
// created only when it does not exist yet, because creating it twice is an error.
export function planGrants(config: SwarmConfig, processes: ProcessSpec[], identities: Map<string, string>,
  ownerIdentity: string, accountId: string, runExists: boolean, policy?: { id: string; json: string }): Command[] {
  const commands: Command[] = [
    { reducer: 'grant_agent', args: [ownerIdentity, 'operator'], note: 'owner acts as operator for run setup' },
  ];
  if (!runExists) commands.push({ reducer: 'create_run', args: [config.runId, config.goal], note: `create run ${config.runId}` });
  if (config.limits) {
    const l = config.limits;
    commands.push({ reducer: 'configure_run_limits', args: [config.runId, l.maxInferences, l.maxTokens, l.maxConcurrent, l.maxAttempts],
      note: 'model budget for the run' });
  }
  for (const p of processes) {
    const identity = identities.get(p.name);
    if (!identity) throw new Error(`No identity for ${p.name}; run "swarm register" first`);
    commands.push({ reducer: 'grant_agent', args: [identity, p.role], note: `${p.name} role` });
    commands.push({ reducer: 'grant_run_access', args: [identity, config.runId], note: `${p.name} reads run ${config.runId}` });
    if (p.accountAccess) {
      if (!accountId) throw new Error(`${p.name} needs account access, but no Alpaca account ID is configured or detectable`);
      commands.push({ reducer: 'grant_account_access', args: [identity, accountId], note: `${p.name} uses the paper account` });
    }
  }
  if (policy) commands.push({ reducer: 'add_risk_policy', args: [policy.id, config.runId, accountId, policy.json], note: 'risk policy for the run' });
  return commands;
}
