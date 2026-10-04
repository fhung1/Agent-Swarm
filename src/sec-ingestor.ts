import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Timestamp } from 'spacetimedb';
import { DbConnection } from './module_bindings/index.js';
import { defaultTokenFile, loadToken, saveToken } from './tokens.js';
import { recordId } from './ids.js';
import { SecClient } from './sec-client.js';
import { extractFilingExcerpts, excerptArtifactName, excerptFactChunks } from './sec-excerpts.js';
import { extractFilingNarrative, requiredNarrativeSections, type FilingForm as NarrativeFilingForm } from './sec-narrative.js';
import { extractEightKExcerpts, isStandaloneQuarterDuration, selectSecFilings, splitEventFact, type SelectedSecFiling } from './sec-updates.js';

// Records the latest 10-K and 10-Q for each symbol as sources, with reported XBRL facts for each filing's own period.
// Each source's checksum is the SHA-256 of the filing document its URI names. Its artifact is a manifest that points to
// a saved copy of that document and to the filing's own XBRL facts, so every recorded fact traces to that filing.
// EDGAR is public research data; this process holds no broker credentials and makes only GET requests to SEC hosts.
const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const SUBMISSIONS_PREFIX = 'https://data.sec.gov/submissions/';
const COMPANY_FACTS_PREFIX = 'https://data.sec.gov/api/xbrl/companyfacts/';
const ARCHIVES_PREFIX = 'https://www.sec.gov/Archives/edgar/data/';

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
type Filing = SelectedSecFiling;

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

let secClient: SecClient | undefined;
async function getSec(url: string, userAgent: string, accept = 'application/json'): Promise<Buffer> {
  secClient ??= new SecClient({ userAgent,
    cacheDir: process.env.SEC_CACHE_DIR ?? path.join(os.homedir(), '.local', 'share', 'quant-swarm', 'cache', 'sec'),
    onEvent: event => console.log(`SEC ${event.kind}: ${event.url}` + (event.delayMs === undefined ? '' : ` (retry in ${event.delayMs}ms)`)),
  });
  return secClient.get(url, accept);
}

async function getSecJson(url: string, userAgent: string): Promise<JsonObject> {
  return object(JSON.parse((await getSec(url, userAgent)).toString('utf8')), url);
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

// Writes content-addressed artifacts once; identical content always maps to the same file.
function saveArtifact(name: string, data: Buffer | string): string {
  fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  const file = path.join(artifactDir, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, data, { mode: 0o600 });
  return file;
}

// Every us-gaap/dei fact entry reported under one accession: the filing's own XBRL data, not later restatements.
function filingFacts(companyFacts: JsonObject, accession: string): JsonObject {
  const result: Record<string, Record<string, Record<string, FactEntry[]>>> = {};
  for (const [taxonomy, concepts] of Object.entries(object(companyFacts.facts, 'facts'))) {
    for (const [concept, body] of Object.entries(object(concepts, taxonomy))) {
      for (const [unit, raw] of Object.entries(object(object(body, concept).units, `${concept} units`))) {
        const entries = (raw as FactEntry[]).filter(entry => entry.accn === accession);
        if (entries.length === 0) continue;
        ((result[taxonomy] ??= {})[concept] ??= {})[unit] = entries;
      }
    }
  }
  return result;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  return value as JsonObject;
}

function latestFilings(submissions: JsonObject): Filing[] {
  const recent = object(object(submissions.filings, 'filings').recent, 'recent filings') as Record<string, unknown[]>;
  const forms = recent.form ?? [];
  const rows = forms.flatMap((form, index) => {
    const accession = recent.accessionNumber?.[index];
    const filingDate = recent.filingDate?.[index];
    const reportDate = recent.reportDate?.[index];
    const acceptedAt = recent.acceptanceDateTime?.[index];
    const primaryDocument = recent.primaryDocument?.[index];
    if ([accession, filingDate, reportDate, acceptedAt, primaryDocument].some(value => value === undefined)) return [];
    return [{ form: String(form), accession: String(accession), filingDate: String(filingDate),
      reportDate: String(reportDate), acceptedAt: String(acceptedAt), primaryDocument: String(primaryDocument),
      items: String(recent.items?.[index] ?? '') }];
  });
  return selectSecFilings(rows);
}

function days(entry: FactEntry): number {
  return entry.start ? (Date.parse(entry.end) - Date.parse(entry.start)) / 86_400_000 : 0;
}

// Picks the value the filing reports for its own period end: the instant value, or the shortest duration ending then
// (the quarter rather than year-to-date in a 10-Q). Prior-period comparatives end on other dates and are skipped.
function factFor(companyFacts: JsonObject, concepts: string[], filing: Filing, metric: string): { concept: string; unit: string; entry: FactEntry } | undefined {
  const usGaap = object(object(companyFacts.facts, 'facts')['us-gaap'] ?? {}, 'us-gaap facts');
  for (const concept of concepts) {
    const units = usGaap[concept] ? object(object(usGaap[concept], concept).units, `${concept} units`) : undefined;
    if (!units) continue;
    for (const [unit, raw] of Object.entries(units)) {
      let entries = (raw as FactEntry[]).filter(entry => entry.accn === filing.accession && entry.end === filing.reportDate);
      if (filing.form === '10-Q' && metric === 'operating_cash_flow') {
        entries = entries.filter(entry => isStandaloneQuarterDuration(entry.start, entry.end));
      }
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
  const submissions = await getSecJson(`${SUBMISSIONS_PREFIX}CIK${cik}.json`, userAgent);
  const filings = latestFilings(submissions);
  if (filings.length === 0) throw new Error(`No selected 10-K, 10-Q or material 8-K filings found for ${symbol}`);
  const financialFilings = filings.some(filing => filing.form.startsWith('10-K') || filing.form.startsWith('10-Q'));
  const companyFactsUrl = `${COMPANY_FACTS_PREFIX}CIK${cik}.json`;
  const companyFacts = financialFilings ? await getSecJson(companyFactsUrl, userAgent) : { facts: {} };
  for (const filing of filings) {
    const accessionDigits = filing.accession.replaceAll('-', '');
    const sourceId = recordId('sec.', `${runId}.${symbol}.${accessionDigits}`);
    const acceptedAt = new Date(filing.acceptedAt);
    if (!Number.isFinite(acceptedAt.getTime())) throw new Error(`Invalid acceptance time for ${filing.accession}`);
    if (!/^[A-Za-z0-9._-]+$/.test(filing.primaryDocument)) throw new Error(`Unexpected document name ${filing.primaryDocument}`);
    const uri = `${ARCHIVES_PREFIX}${Number(cik)}/${accessionDigits}/${filing.primaryDocument}`;
    const document = await getSec(uri, userAgent, 'text/html,application/xhtml+xml,*/*');
    const checksum = sha256(document);
    const documentPath = saveArtifact(`${checksum}${path.extname(filing.primaryDocument) || '.htm'}`, document);
    const isEightK = filing.form === '8-K' || filing.form === '8-K/A';
    const isAmendment = filing.form === '10-K/A' || filing.form === '10-Q/A';
    const excerpts = isEightK ? undefined : extractFilingExcerpts(document, filing.form);
    const excerptArtifact = excerpts ? excerptArtifactName(excerpts) : undefined;
    const excerptPath = excerptArtifact ? saveArtifact(excerptArtifact.name, excerptArtifact.data) : undefined;
    const excerptChunks = excerpts ? excerptFactChunks(excerpts, sourceId) : [];
    const eventExcerpts = isEightK ? extractEightKExcerpts(document.toString('utf8'), filing.itemCodes) : [];
    const narrativeForm = isEightK ? undefined : filing.form as NarrativeFilingForm;
    const narrativeSections = narrativeForm ? extractFilingNarrative(document.toString('utf8'), narrativeForm) : [];
    const availableNarrative = new Set(narrativeSections.map(section => section.key));
    const missingNarrative = narrativeForm ? requiredNarrativeSections(narrativeForm).filter(section => !availableNarrative.has(section)) : [];
    if (missingNarrative.length && !isAmendment) {
      throw new Error(`${symbol} ${filing.form} ${filing.accession} did not yield required filing sections: ${missingNarrative.join(', ')}`);
    }
    // An amendment supersedes an earlier source only when it carries every required narrative section.
    // Partial amendments are durable additive evidence and leave the prior source eligible.
    const supersedesSourceId = isAmendment && !missingNarrative.length && filing.supersedesAccession
      ? recordId('sec.', `${runId}.${symbol}.${filing.supersedesAccession.replaceAll('-', '')}`) : undefined;
    const provenance = JSON.stringify({ accession: filing.accession, form: filing.form,
      reportDate: filing.reportDate || filing.filingDate, acceptedAt: filing.acceptedAt,
      ...(supersedesSourceId ? { supersedesSourceId } : {}) });
    const eventFacts = eventExcerpts.map(excerpt => ({ item: excerpt.item, value: splitEventFact(excerpt.text)[0] ?? '' }))
      .filter(excerpt => excerpt.value.length > 0);
    const narrativeArtifact = JSON.stringify({
      accession: filing.accession, form: filing.form,
      sections: narrativeSections.map(({ key, item, label, chunks }) => ({ key, item, label, excerpt: chunks.join('') })),
    });
    const narrativeChecksum = sha256(narrativeArtifact);
    const narrativePath = saveArtifact(`${narrativeChecksum}.narrative.json`, narrativeArtifact);
    // Keep provenance, filing facts and event facts within the evidence protocol's 48-fact / 49-ref bounds:
    // two complete financial filings use at most 35 facts; two event sources add at most eight.
    // Full extracted narrative remains in the artifact; omitted fact characters are explicit below.
    const narrativeFacts = narrativeSections.flatMap(section => section.chunks.slice(0, 1).map((value, index) => ({
      id: recordId('', sourceId, `.narrative.${section.key}.${String(index + 1).padStart(2, '0')}`),
      metric: `filing_${section.key}_${String(index + 1).padStart(2, '0')}`,
      value,
      unit: 'text',
      period: `Item ${section.item}; accession ${filing.accession}; accepted ${filing.acceptedAt}`,
    })));
    const xbrl = isEightK ? undefined : JSON.stringify(filingFacts(companyFacts, filing.accession));
    const xbrlChecksum = xbrl ? sha256(xbrl) : undefined;
    const xbrlPath = xbrl && xbrlChecksum ? saveArtifact(`${xbrlChecksum}.json`, xbrl) : undefined;
    const manifest = JSON.stringify({
      sourceId, accession: filing.accession, form: filing.form, cik, symbol, reportDate: filing.reportDate,
      acceptedAt: filing.acceptedAt, items: filing.itemCodes,
      ...(supersedesSourceId ? { supersedesSourceId } : {}),
      document: { uri, sha256: checksum, bytes: document.length, path: documentPath },
      ...(xbrlChecksum && xbrlPath ? { xbrlFacts: { derivedFrom: companyFactsUrl, accession: filing.accession, sha256: xbrlChecksum, path: xbrlPath } } : {}),
      ...(excerptArtifact && excerptPath ? { qualitativeExcerpts: { derivedFrom: uri, sha256: excerptArtifact.checksum, path: excerptPath,
        offsetsIn: 'normalized visible text, sec-text-v1', chunks: excerptChunks.map(({ value, ...chunk }) => ({ ...chunk, sha256: sha256(value) })) },
      } : {}),
      eventUpdates: eventExcerpts.map(({ text, ...excerpt }) => ({ ...excerpt, factId: recordId('', sourceId, `.event.${excerpt.item.replace('.', '_')}`), sha256: sha256(text) })),
      narrative: {
        sha256: narrativeChecksum, path: narrativePath,
        sections: narrativeSections.map(({ key, item, label, chunks }) => ({
          key, item, label, characters: chunks.join('').length,
          charactersOmittedFromFacts: chunks.slice(1).join('').length,
          facts: chunks.slice(0, 1).map((_, index) => recordId('', sourceId, `.narrative.${key}.${String(index + 1).padStart(2, '0')}`)),
        })),
      },
    }, null, 2);
    const manifestPath = saveArtifact(`${sha256(manifest)}.manifest.json`, manifest);
    const added = await idempotent(sourceId, () => conn.reducers.addSource({
      id: sourceId, runId, symbol, kind: filing.form, uri,
      asOf: Timestamp.fromDate(acceptedAt), checksum, artifactRef: `file://${manifestPath}`,
    }));
    let recorded = 0;
    const missing: string[] = [];
    const metadataFacts = [{ id: recordId('', sourceId, '.filing_provenance'), metric: 'filing_provenance',
      value: provenance, period: `${filing.form}; accession ${filing.accession}; accepted ${filing.acceptedAt}` },
    ...(isEightK || isAmendment ? [{ id: recordId('', sourceId, '.filing_update_review'), metric: 'filing_update_review',
      value: 'review_required', period: `${isEightK ? `Items ${filing.itemCodes.join(',')}` : filing.form}; accession ${filing.accession}; accepted ${filing.acceptedAt}` }] : [])];
    for (const fact of metadataFacts) {
      if (await idempotent(fact.id, () => conn.reducers.addFact({ ...fact, sourceId, symbol, unit: 'text', quality: 'ok' }))) recorded++;
    }
    for (const [metric, concepts] of Object.entries(CONCEPTS)) {
      if (isEightK) break;
      const found = factFor(companyFacts, concepts, filing, metric);
      if (!found) { missing.push(metric); continue; }
      const { entry, unit, concept } = found;
      const period = entry.start ? `${entry.start}..${entry.end}` : `as of ${entry.end}`;
      if (await idempotent(`${sourceId}.${metric}`, () => conn.reducers.addFact({
        id: recordId('', sourceId, `.${metric}`), sourceId, symbol, metric, value: String(entry.val), unit,
        period: `${period} (${concept})`, quality: 'ok',
      }))) recorded++;
    }
    for (const chunk of excerptChunks) {
      if (await idempotent(chunk.id, () => conn.reducers.addFact({ id: chunk.id, sourceId, symbol,
        metric: chunk.metric, value: chunk.value, unit: 'text', period: filing.reportDate || filing.filingDate, quality: chunk.quality }))) recorded++;
    }
    if (excerpts?.missing.length) console.log(`${symbol} ${filing.form}: excerpt sections not found: ${excerpts.missing.join(', ')}`);
    for (const fact of narrativeFacts) {
      if (await idempotent(`${sourceId}.${fact.metric}`, () => conn.reducers.addFact({
        ...fact, sourceId, symbol, quality: 'ok',
      }))) recorded++;
    }
    for (const fact of eventFacts) {
      const itemKey = fact.item.replace('.', '_');
      if (await idempotent(`${sourceId}.event.${itemKey}`, () => conn.reducers.addFact({
        id: recordId('', sourceId, `.event.${itemKey}`), sourceId, symbol,
        metric: `filing_event_${itemKey}`, value: fact.value, unit: 'text',
        period: `Item ${fact.item}; accession ${filing.accession}; accepted ${filing.acceptedAt}`, quality: 'ok',
      }))) recorded++;
    }
    console.log(`${symbol} ${filing.form} ${filing.accession} (period ${filing.reportDate}, accepted ${filing.acceptedAt}): ` +
      `${added ? 'source recorded' : 'source already recorded'}, ${recorded} new facts, ${narrativeSections.length} narrative sections` +
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
    const tickers = await getSecJson(TICKERS_URL, userAgent);
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
