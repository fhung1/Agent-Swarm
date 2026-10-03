import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Timestamp } from 'spacetimedb';
import { DbConnection } from './module_bindings/index.js';

const PAPER_API = 'https://paper-api.alpaca.markets';
const MARKET_DATA_API = 'https://data.alpaca.markets';
const ALLOWED_FEEDS = ['sip', 'iex', 'delayed_sip', 'boats', 'overnight', 'otc'] as const;
const ALLOWED_READ_PATHS = new Set([
  `${PAPER_API}/v2/account`,
  `${PAPER_API}/v2/positions`,
  `${PAPER_API}/v2/orders`,
  `${MARKET_DATA_API}/v2/stocks/quotes/latest`,
]);
type Feed = typeof ALLOWED_FEEDS[number];
type JsonObject = Record<string, unknown>;

const host = process.env.SPACETIMEDB_HOST ?? 'ws://localhost:3000';
const database = process.env.SPACETIMEDB_DB_NAME ?? 'quant-swarm';
const tokenFile = process.env.SPACETIMEDB_TOKEN_FILE ??
  path.join(os.homedir(), '.local', 'share', 'quant-swarm', 'tokens', 'alpaca-reader.token');

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function parseFeed(value: string): Feed {
  if (!(ALLOWED_FEEDS as readonly string[]).includes(value)) {
    throw new Error(`ALPACA_DATA_FEED must be one of: ${ALLOWED_FEEDS.join(', ')}`);
  }
  return value as Feed;
}

function parseSymbols(value: string): string[] {
  const result = [...new Set(value.split(',').map(symbol => symbol.trim().toUpperCase()))];
  if (result.length < 1 || result.length > 50 || result.some(symbol => !/^[A-Z][A-Z0-9.-]{0,15}$/.test(symbol))) {
    throw new Error('ALPACA_SYMBOLS must contain 1 to 50 comma-separated US equity symbols');
  }
  return result;
}

function readToken(): string | undefined {
  try { return fs.readFileSync(tokenFile, 'utf8').trim() || undefined; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function saveToken(token: string): void {
  fs.mkdirSync(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  fs.chmodSync(tokenFile, 0o600);
}

async function getJson<T>(url: URL, apiKey: string, apiSecret: string): Promise<T> {
  if (!ALLOWED_READ_PATHS.has(`${url.origin}${url.pathname}`)) {
    throw new Error(`Alpaca read route is not allow-listed: ${url.origin}${url.pathname}`);
  }
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    headers: {
      accept: 'application/json',
      'APCA-API-KEY-ID': apiKey,
      'APCA-API-SECRET-KEY': apiSecret,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 400).replace(/[\r\n]+/g, ' ');
    throw new Error(`Alpaca GET ${url.origin}${url.pathname} failed (${response.status}): ${detail}`);
  }
  return await response.json() as T;
}

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label} response`);
  return value as JsonObject;
}

function textField(value: JsonObject, key: string, label = key): string {
  const field = value[key];
  if (typeof field !== 'string' || !field.trim()) throw new Error(`Alpaca response is missing ${label}`);
  return field;
}

function amountField(value: JsonObject, key: string): string {
  const field = value[key];
  if ((typeof field !== 'string' && typeof field !== 'number') || !Number.isFinite(Number(field))) {
    throw new Error(`Alpaca response has invalid ${key}`);
  }
  const result = String(field);
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(result)) throw new Error(`Alpaca response has invalid ${key}`);
  return result;
}

function parseQuote(symbol: string, raw: unknown, snapshotId: string, feed: Feed) {
  const quote = object(raw, `quote for ${symbol}`);
  const asOfText = textField(quote, 't', `${symbol} quote timestamp`);
  const asOfDate = new Date(asOfText);
  if (!Number.isFinite(asOfDate.getTime())) throw new Error(`Alpaca returned an invalid quote timestamp for ${symbol}`);
  const fraction = /[.,](\d+)(?=Z|[+-]\d{2}:?\d{2}$)/i.exec(asOfText)?.[1] ?? '';
  const microseconds = Number((fraction + '000000').slice(0, 6));
  const milliseconds = Number((fraction + '000').slice(0, 3));
  const asOf = new Timestamp(Timestamp.fromDate(asOfDate).microsSinceUnixEpoch + BigInt(microseconds - milliseconds * 1000));
  return {
    id: `${snapshotId}.${symbol}`, symbol, feed,
    bidPrice: amountField(quote, 'bp'), bidSize: amountField(quote, 'bs'),
    askPrice: amountField(quote, 'ap'), askSize: amountField(quote, 'as'),
    asOf,
  };
}

function connectDatabase(): Promise<DbConnection> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let connection: DbConnection | undefined;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      connection?.disconnect();
      reject(new Error('Timed out connecting to SpacetimeDB'));
    }, 15_000);

    connection = DbConnection.builder()
      .withUri(host)
      .withDatabaseName(database)
      .withToken(readToken())
      .onConnect((conn, identity, token) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        try {
          saveToken(token);
          console.log(`Connected to SpacetimeDB as ${identity.toHexString()}`);
          resolve(conn);
        } catch (error) {
          conn.disconnect();
          reject(error);
        }
      })
      .onConnectError((_ctx, error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`Could not connect to SpacetimeDB: ${String(error)}`));
      })
      .build();
  });
}

async function main(): Promise<void> {
  const connection = await connectDatabase();
  try {
    if (process.argv.includes('--register')) {
      console.log(`Registered Alpaca paper adapter identity. Grant it the market_data role before taking snapshots.`);
      return;
    }

    const apiKey = requiredEnv('ALPACA_API_KEY');
    const apiSecret = requiredEnv('ALPACA_API_SECRET');
    const feed = parseFeed(requiredEnv('ALPACA_DATA_FEED'));
    const symbols = parseSymbols(requiredEnv('ALPACA_SYMBOLS'));

    // The trading origin is fixed to Alpaca's paper API. All broker and market requests use GET.
    const [accountRaw, positionsRaw, ordersRaw, quotesRaw] = await Promise.all([
      getJson<unknown>(new URL('/v2/account', PAPER_API), apiKey, apiSecret),
      getJson<unknown>(new URL('/v2/positions', PAPER_API), apiKey, apiSecret),
      getOpenOrders(apiKey, apiSecret),
      getLatestQuotes(apiKey, apiSecret, symbols, feed),
    ]);

    const account = object(accountRaw, 'account');
    if (!Array.isArray(positionsRaw) || !Array.isArray(ordersRaw)) throw new Error('Alpaca returned invalid positions or orders');
    const quoteResponse = object(quotesRaw, 'latest quotes');
    const quoteMap = object(quoteResponse.quotes, 'latest quotes map');
    const snapshotId = randomUUID();
    const observations = symbols.map(symbol => {
      const quote = quoteMap[symbol];
      if (!quote) throw new Error(`Alpaca returned no latest quote for ${symbol}`);
      return parseQuote(symbol, quote, snapshotId, feed);
    });

    await connection.reducers.recordAccountSnapshot({
      id: snapshotId,
      accountId: textField(account, 'id', 'account ID'),
      accountStatus: textField(account, 'status', 'account status'),
      cash: amountField(account, 'cash'),
      buyingPower: amountField(account, 'buying_power'),
      equity: amountField(account, 'equity'),
      positionsJson: JSON.stringify(positionsRaw),
      openOrdersJson: JSON.stringify(ordersRaw),
      observations,
    });
    console.log(`Recorded paper account snapshot ${snapshotId}: ${positionsRaw.length} positions, ${ordersRaw.length} open orders, ${observations.length} ${feed} quotes.`);
    for (const observation of observations) {
      console.log(`${observation.symbol}: bid ${observation.bidPrice} x ${observation.bidSize}, ask ${observation.askPrice} x ${observation.askSize}, as of ${observation.asOf.toISOString()}`);
    }
  } finally {
    connection.disconnect();
  }
}

async function getOpenOrders(apiKey: string, apiSecret: string): Promise<unknown[]> {
  const orders: unknown[] = [];
  let beforeOrderId: string | undefined;
  do {
    const url = new URL('/v2/orders', PAPER_API);
    url.searchParams.set('status', 'open');
    url.searchParams.set('direction', 'desc');
    url.searchParams.set('limit', '500');
    if (beforeOrderId) url.searchParams.set('before_order_id', beforeOrderId);
    const page = await getJson<unknown>(url, apiKey, apiSecret);
    if (!Array.isArray(page)) throw new Error('Alpaca returned invalid open orders');
    orders.push(...page);
    if (orders.length > 10_000) throw new Error('Open order snapshot exceeds the 10,000-order safety limit');
    if (page.length < 500) break;
    const last = object(page[page.length - 1], 'open order');
    const nextId = textField(last, 'id', 'open order ID');
    if (nextId === beforeOrderId) throw new Error('Alpaca open-order pagination did not advance');
    beforeOrderId = nextId;
  } while (beforeOrderId);
  return orders;
}

async function getLatestQuotes(apiKey: string, apiSecret: string, symbols: string[], feed: Feed): Promise<unknown> {
  const url = new URL('/v2/stocks/quotes/latest', MARKET_DATA_API);
  url.searchParams.set('symbols', symbols.join(','));
  url.searchParams.set('feed', feed);
  return getJson<unknown>(url, apiKey, apiSecret);
}

void main().catch(error => {
  console.error(`Read-only Alpaca snapshot failed: ${String(error)}`);
  process.exitCode = 1;
});
