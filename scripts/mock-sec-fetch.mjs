// Test-only replay of previously saved real SEC artifacts; reject all other fetch destinations.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const directory = process.env.SEC_REPLAY_DIR;
if (!directory) throw new Error('SEC_REPLAY_DIR required');
const actualFetch = globalThis.fetch;
const temporaryOrigin = process.env.SPACETIMEDB_HOST?.replace(/^ws/, 'http');
const manifests = readdirSync(directory).filter(name => name.endsWith('.manifest.json'))
  .map(name => JSON.parse(readFileSync(join(directory, name), 'utf8'))).filter(row => row.document && ['AAPL', 'MSFT'].includes(row.symbol));
const records = new Map();
const tickers = {};
for (const symbol of ['AAPL', 'MSFT']) {
  const filings = ['10-K','10-Q'].map(form => manifests.filter(row => row.symbol === symbol && row.form === form)
    .sort((a,b)=>Date.parse(b.acceptedAt)-Date.parse(a.acceptedAt))[0]).filter(Boolean);
  if (filings.length !== 2) throw new Error(`Replay needs saved ${symbol} 10-K and 10-Q artifacts`);
  const cik = filings[0].cik;
  tickers[symbol] = { ticker: symbol, cik_str: Number(cik) };
  const recent = { form: [], accessionNumber: [], filingDate: [], reportDate: [], acceptanceDateTime: [], primaryDocument: [] };
  const facts = {};
  for (const filing of filings) {
    recent.form.push(filing.form); recent.accessionNumber.push(filing.accession);
    recent.filingDate.push(filing.acceptedAt.slice(0, 10)); recent.reportDate.push(filing.reportDate);
    recent.acceptanceDateTime.push(filing.acceptedAt); recent.primaryDocument.push(filing.document.uri.split('/').at(-1));
    records.set(filing.document.uri, readFileSync(filing.document.path));
    const saved = JSON.parse(readFileSync(filing.xbrlFacts.path, 'utf8'));
    for (const [taxonomy, concepts] of Object.entries(saved)) {
      facts[taxonomy] ??= {};
      for (const [concept, units] of Object.entries(concepts)) {
        facts[taxonomy][concept] ??= { units: {} };
        for (const [unit, entries] of Object.entries(units)) (facts[taxonomy][concept].units[unit] ??= []).push(...entries);
      }
    }
  }
  records.set(`https://data.sec.gov/submissions/CIK${cik}.json`, Buffer.from(JSON.stringify({ filings: { recent } })));
  records.set(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, Buffer.from(JSON.stringify({ facts })));
}
records.set('https://www.sec.gov/files/company_tickers.json', Buffer.from(JSON.stringify(tickers)));
globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url === `${temporaryOrigin}/v1/identity/websocket-token`) return actualFetch(input, init);
  if (process.env.SEC_REPLAY_FAIL_MSFT === '1' && url.includes(`CIK${manifests.find(row => row.symbol === 'MSFT').cik}.json`)) return new Response('synthetic permanent refusal', { status: 403 });
  const body = records.get(url);
  if (!body) throw new Error(`Test replay refused unexpected URL: ${url}`);
  return new Response(body, { headers: { etag: '"saved-replay"' } });
};
