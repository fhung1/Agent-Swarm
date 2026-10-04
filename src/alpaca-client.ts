import { Timestamp } from 'spacetimedb';

// Read-only Alpaca client shared by the paper adapter and the risk worker.
// Origins are fixed to the paper trading host and market-data host; every request is an allow-listed GET.
export const PAPER_API = 'https://paper-api.alpaca.markets';
export const MARKET_DATA_API = 'https://data.alpaca.markets';
export const ALLOWED_FEEDS = ['sip', 'iex', 'delayed_sip', 'boats', 'overnight', 'otc'] as const;
const ALLOWED_READ_PATHS = new Set([
  `${PAPER_API}/v2/account`,
  `${PAPER_API}/v2/positions`,
  `${PAPER_API}/v2/orders`,
  `${PAPER_API}/v2/clock`,
  `${MARKET_DATA_API}/v2/stocks/quotes/latest`,
]);
export type Feed = typeof ALLOWED_FEEDS[number];
export type JsonObject = Record<string, unknown>;
export interface AlpacaCredentials { apiKey: string; apiSecret: string }

export function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function credentialsFromEnv(): AlpacaCredentials {
  return { apiKey: requiredEnv('ALPACA_API_KEY'), apiSecret: requiredEnv('ALPACA_API_SECRET') };
}

/** Read adapters use a separately provisioned credential; order credentials stay in executor only. */
export function readCredentialsFromEnv(): AlpacaCredentials {
  return { apiKey: requiredEnv('ALPACA_READ_API_KEY'), apiSecret: requiredEnv('ALPACA_READ_API_SECRET') };
}

export function parseFeed(value: string): Feed {
  if (!(ALLOWED_FEEDS as readonly string[]).includes(value)) {
    throw new Error(`ALPACA_DATA_FEED must be one of: ${ALLOWED_FEEDS.join(', ')}`);
  }
  return value as Feed;
}

export async function getJson<T>(url: URL, credentials: AlpacaCredentials): Promise<T> {
  if (!ALLOWED_READ_PATHS.has(`${url.origin}${url.pathname}`)) {
    throw new Error(`Alpaca read route is not allow-listed: ${url.origin}${url.pathname}`);
  }
  const response = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    headers: {
      accept: 'application/json',
      'APCA-API-KEY-ID': credentials.apiKey,
      'APCA-API-SECRET-KEY': credentials.apiSecret,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 400).replace(/[\r\n]+/g, ' ');
    throw new Error(`Alpaca GET ${url.origin}${url.pathname} failed (${response.status}): ${detail}`);
  }
  return await response.json() as T;
}

export function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label} response`);
  return value as JsonObject;
}

export function textField(value: JsonObject, key: string, label = key): string {
  const field = value[key];
  if (typeof field !== 'string' || !field.trim()) throw new Error(`Alpaca response is missing ${label}`);
  return field;
}

export function amountField(value: JsonObject, key: string): string {
  const field = value[key];
  if ((typeof field !== 'string' && typeof field !== 'number') || !Number.isFinite(Number(field))) {
    throw new Error(`Alpaca response has invalid ${key}`);
  }
  const result = String(field);
  if (!/^(0|[1-9]\d*)(\.\d+)?$/.test(result)) throw new Error(`Alpaca response has invalid ${key}`);
  return result;
}

// Alpaca defines daily balance change as current equity minus equity at the prior market close.
// Keep the subtraction exact to the database's 12-decimal money precision.
export function dailyPnlField(account: JsonObject): string | undefined {
  if (account.last_equity === undefined || account.last_equity === null || account.last_equity === '') return undefined;
  const toUnits = (key: string): bigint => {
    const amount = amountField(account, key);
    const match = /^(0|[1-9]\d*)(?:\.(\d{1,12}))?$/.exec(amount);
    if (!match) throw new Error(`Alpaca response has invalid ${key} precision`);
    return BigInt(match[1]) * 1_000_000_000_000n + BigInt((match[2] ?? '').padEnd(12, '0') || '0');
  };
  const change = toUnits('equity') - toUnits('last_equity');
  if (change === 0n) return '0';
  const sign = change < 0n ? '-' : '';
  const absolute = change < 0n ? -change : change;
  const whole = absolute / 1_000_000_000_000n;
  const fraction = (absolute % 1_000_000_000_000n).toString().padStart(12, '0').replace(/0+$/, '');
  return `${sign}${whole}${fraction ? `.${fraction}` : ''}`;
}

// Normalizes one latest-quote entry, keeping the microsecond precision of Alpaca's timestamp.
export function parseQuote(symbol: string, raw: unknown) {
  const quote = object(raw, `quote for ${symbol}`);
  const asOfText = textField(quote, 't', `${symbol} quote timestamp`);
  const asOfDate = new Date(asOfText);
  if (!Number.isFinite(asOfDate.getTime())) throw new Error(`Alpaca returned an invalid quote timestamp for ${symbol}`);
  const fraction = /[.,](\d+)(?=Z|[+-]\d{2}:?\d{2}$)/i.exec(asOfText)?.[1] ?? '';
  const microseconds = Number((fraction + '000000').slice(0, 6));
  const milliseconds = Number((fraction + '000').slice(0, 3));
  const asOf = new Timestamp(Timestamp.fromDate(asOfDate).microsSinceUnixEpoch + BigInt(microseconds - milliseconds * 1000));
  return {
    symbol,
    bidPrice: amountField(quote, 'bp'), bidSize: amountField(quote, 'bs'),
    askPrice: amountField(quote, 'ap'), askSize: amountField(quote, 'as'),
    asOf,
  };
}

export function getAccount(credentials: AlpacaCredentials): Promise<unknown> {
  return getJson<unknown>(new URL('/v2/account', PAPER_API), credentials);
}

export function getPositions(credentials: AlpacaCredentials): Promise<unknown> {
  return getJson<unknown>(new URL('/v2/positions', PAPER_API), credentials);
}

export async function getOpenOrders(credentials: AlpacaCredentials): Promise<unknown[]> {
  const orders: unknown[] = [];
  let beforeOrderId: string | undefined;
  do {
    const url = new URL('/v2/orders', PAPER_API);
    url.searchParams.set('status', 'open');
    url.searchParams.set('direction', 'desc');
    url.searchParams.set('limit', '500');
    if (beforeOrderId) url.searchParams.set('before_order_id', beforeOrderId);
    const page = await getJson<unknown>(url, credentials);
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

export function getLatestQuotes(credentials: AlpacaCredentials, symbols: string[], feed: Feed): Promise<unknown> {
  const url = new URL('/v2/stocks/quotes/latest', MARKET_DATA_API);
  url.searchParams.set('symbols', symbols.join(','));
  url.searchParams.set('feed', feed);
  return getJson<unknown>(url, credentials);
}

// Alpaca's market clock accounts for holidays and early closes; local time does not.
export async function getMarketOpen(credentials: AlpacaCredentials): Promise<boolean> {
  const clock = object(await getJson<unknown>(new URL('/v2/clock', PAPER_API), credentials), 'clock');
  if (typeof clock.is_open !== 'boolean') throw new Error('Alpaca clock response is missing is_open');
  return clock.is_open;
}
