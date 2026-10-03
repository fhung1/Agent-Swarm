import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Timestamp } from 'spacetimedb';
import { DbConnection } from './module_bindings/index.js';
import { defaultTokenFile, loadToken, saveToken } from './tokens.js';

// Records the latest 10-K and 10-Q for each symbol as sources, with reported XBRL facts for each filing's own period.
// EDGAR is public research data; this process holds no broker credentials and makes only GET requests to SEC hosts.
const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SUBMISSIONS_PREFIX = 'https://data.sec.gov/submissions/';
const COMPANY_FACTS_PREFIX = 'https://data.sec.gov/api/xbrl/companyfacts/';
const REQUEST_GAP_MS = 200; // SEC fair access allows 10 requests per second; stay well below it.
const FORMS = ['10-K', '10-Q'];

// Metric name → us-gaap concepts in preference order. Companies tag the same line item differently.
const CONCEPTS: Record<string, string[]> = {
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'],
  net_income: ['NetIncomeLoss'],
  operating_income: ['OperatingIncomeLoss'],
  operating_cash_flow: ['NetCashProvidedByUsedInOperatingActivities'],
  eps_diluted: ['EarningsPerShareDiluted'],
  total_assets: ['Assets'],
  total_liabilities: ['Liabilities'],
  stockholders_equity: ['StockholdersEquity'],
  cash: ['CashAndCashEquivalentsAtCarryingValue'],
  long_term_debt: ['LongTermDebtNoncurrent', 'LongTermDebt'],
};

const host = process.env.SPACETIMEDB_HOST ?? 'ws://localhost:3000';
const database = process.env.SPACETIMEDB_DB_NAME ?? 'quant-swarm';
const runId = process.env.RUN_ID ?? 'demo';
const tokenFile = process.env.SPACETIMEDB_TOKEN_FILE ?? defaultTokenFile('sec-ingestor');
const artifactDir = process.env.SEC_ARTIFACT_DIR ??
  path.join(os.homedir(), '.local', 'share', 'quant-swarm', 'artifacts', 'sec');

type JsonObject = Record<string, unknown>;
type FactEntry = { start?: string; end: string; val: number; accn: string; form: string; filed: string };
type Filing = { form: string; accession: string; filingDate: string; reportDate: string; acceptedAt: string; primaryDocument: string };

if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(runId)) throw new Error('RUN_ID has invalid characters or exceeds 64 characters');

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function parseSymbols(value: string): string[] {
  const result = [...new Set(value.split(',').map(symbol => symbol.trim().toUpperCase()))];
  if (result.length < 1 || result.length > 20 || result.some(symbol => !/^[A-Z][A-Z0-9.-]{0,15}$/.test(symbol))) {
    throw new Error('SYMBOLS must contain 1 to 20 comma-separated US equity symbols');
  }
  return result;
}

let lastRequest = 0;
async function getSec(url: string, userAgent: string): Promise<string> {
  if (url !== TICKERS_URL && !url.startsWith(SUBMISSIONS_PREFIX) && !url.startsWith(COMPANY_FACTS_PREFIX)) {
    throw new Error(`SEC route is not allow-listed: ${url}`);
  }
  const wait = lastRequest + REQUEST_GAP_MS - Date.now();
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  lastRequest = Date.now();
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    headers: { 'user-agent': userAgent, accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`SEC GET ${url} failed (${response.status})`);
  return await response.text();
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as JsonObject;
}

function latestFilings(submissions: JsonObject): Filing[] {
  const recent = object(object(submissions.filings, 'filings').recent, 'recent filings') as Record<string, unknown[]>;
  const forms = recent.form ?? [];
  const result: Filing[] = [];
  for (const form of FORMS) {
    // EDGAR lists recent filings newest first; take the newest original (non-amended) filing of each form.
    const index = forms.findIndex(value => value === form);
    if (index < 0) continue;
    result.push({
      form,
      accession: String(recent.accessionNumber[index]),
      filingDate: String(recent.filingDate[index]),
      reportDate: String(recent.reportDate[index]),
      acceptedAt: String(recent.acceptanceDateTime[index]),
      primaryDocument: String(recent.primaryDocument[index]),
    });
  }
  return result;
}

function days(entry: FactEntry): number {
  return entry.start ? (Date.parse(entry.end) - Date.parse(entry.start)) / 86_400_000 : 0;
}

// Picks the value the filing reports for its own period end: the instant value, or the shortest duration ending then
// (the quarter rather than year-to-date in a 10-Q). Prior-period comparatives end on other dates and are skipped.
function factFor(companyFacts: JsonObject, concepts: string[], filing: Filing): { concept: string; unit: string; entry: FactEntry } | undefined {
  const usGaap = object(object(companyFacts.facts, 'facts')['us-gaap'] ?? {}, 'us-gaap facts');
  for (const concept of concepts) {
    const units = usGaap[concept] ? object(object(usGaap[concept], concept).units, `${concept} units`) : undefined;
    if (!units) continue;
    for (const [unit, raw] of Object.entries(units)) {
      const entries = (raw as FactEntry[]).filter(entry => entry.accn === filing.accession && entry.end === filing.reportDate);
      if (entries.length === 0) continue;
      entries.sort((a, b) => days(a) - days(b));
      return { concept, unit, entry: entries[0] };
    }
  }
  return undefined;
}

function connectDatabase(): Promise<DbConnection> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timed out connecting to SpacetimeDB')), 15_000);
    DbConnection.builder()
      .withUri(host)
      .withDatabaseName(database)
      .withToken(loadToken(tokenFile))
      .onConnect((conn, identity, token) => {
        clearTimeout(timeout);
        saveToken(tokenFile, token);
        console.log(`Connected to SpacetimeDB as ${identity.toHexString()}`);
        resolve(conn);
      })
      .onConnectError((_ctx, error) => {
        clearTimeout(timeout);
        reject(new Error(`Could not connect to SpacetimeDB: ${String(error)}`));
      })
      .build();
  });
}

// Treat "already exists" as success so the ingestor can be rerun for the same run.
async function idempotent(label: string, call: () => Promise<void>): Promise<boolean> {
  try { await call(); return true; }
  catch (error) {
    if (!String(error).includes('already exists')) throw new Error(`${label}: ${String(error)}`);
    return false;
  }
}

async function ingestSymbol(conn: DbConnection, userAgent: string, symbol: string, ciks: Map<string, string>): Promise<void> {
  const cik = ciks.get(symbol.replace('.', '-'));
  if (!cik) throw new Error(`No SEC CIK found for ${symbol}`);
  const submissions = object(JSON.parse(await getSec(`${SUBMISSIONS_PREFIX}CIK${cik}.json`, userAgent)), 'submissions');
  const factsBody = await getSec(`${COMPANY_FACTS_PREFIX}CIK${cik}.json`, userAgent);
  const companyFacts = object(JSON.parse(factsBody), 'company facts');

  // Keep the raw company-facts document outside SpacetimeDB; sources reference it by checksum and path.
  const checksum = createHash('sha256').update(factsBody).digest('hex');
  fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  const artifactPath = path.join(artifactDir, `${checksum}.json`);
  if (!fs.existsSync(artifactPath)) fs.writeFileSync(artifactPath, factsBody, { mode: 0o600 });

  const filings = latestFilings(submissions);
  if (filings.length === 0) throw new Error(`No 10-K or 10-Q filings found for ${symbol}`);
  for (const filing of filings) {
    const accessionDigits = filing.accession.replaceAll('-', '');
    const sourceId = `sec.${runId}.${symbol}.${accessionDigits}`;
    const acceptedAt = new Date(filing.acceptedAt);
    if (!Number.isFinite(acceptedAt.getTime())) throw new Error(`Invalid acceptance time for ${filing.accession}`);
    const added = await idempotent(sourceId, () => conn.reducers.addSource({
      id: sourceId, runId, symbol, kind: filing.form,
      uri: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accessionDigits}/${filing.primaryDocument}`,
      asOf: Timestamp.fromDate(acceptedAt), checksum, artifactRef: `file://${artifactPath}`,
    }));
    let recorded = 0;
    const missing: string[] = [];
    for (const [metric, concepts] of Object.entries(CONCEPTS)) {
      const found = factFor(companyFacts, concepts, filing);
      if (!found) { missing.push(metric); continue; }
      const { entry, unit, concept } = found;
      const period = entry.start ? `${entry.start}..${entry.end}` : `as of ${entry.end}`;
      if (await idempotent(`${sourceId}.${metric}`, () => conn.reducers.addFact({
        id: `${sourceId}.${metric}`, sourceId, symbol, metric, value: String(entry.val), unit,
        period: `${period} (${concept})`, quality: 'ok',
      }))) recorded++;
    }
    console.log(`${symbol} ${filing.form} ${filing.accession} (period ${filing.reportDate}, accepted ${filing.acceptedAt}): ` +
      `${added ? 'source recorded' : 'source already recorded'}, ${recorded} new facts` +
      (missing.length ? `; not reported: ${missing.join(', ')}` : ''));
  }
}

async function main(): Promise<void> {
  const conn = await connectDatabase();
  try {
    if (process.argv.includes('--register')) {
      console.log('Registered SEC ingestor identity. Grant it the ingestor role before ingesting filings.');
      return;
    }
    const userAgent = requiredEnv('SEC_USER_AGENT');
    if (!/\S+@\S+\.\S+/.test(userAgent)) throw new Error('SEC_USER_AGENT must include a contact email, as SEC fair-access policy requires');
    const symbols = parseSymbols(requiredEnv('SYMBOLS'));
    const tickers = object(JSON.parse(await getSec(TICKERS_URL, userAgent)), 'company tickers');
    const ciks = new Map<string, string>();
    for (const row of Object.values(tickers)) {
      const { ticker, cik_str: cik } = object(row, 'ticker row');
      ciks.set(String(ticker).toUpperCase(), String(cik).padStart(10, '0'));
    }
    for (const symbol of symbols) await ingestSymbol(conn, userAgent, symbol, ciks);
  } finally {
    conn.disconnect();
  }
}

void main().catch(error => {
  console.error(`SEC ingest failed: ${String(error)}`);
  process.exitCode = 1;
});
