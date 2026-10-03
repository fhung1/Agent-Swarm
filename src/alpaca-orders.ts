import { PAPER_API, object, type AlpacaCredentials, type JsonObject } from './alpaca-client.js';

// Paper-only order client used by the executor. The origin is fixed to Alpaca's paper trading host; there is no
// live endpoint and no override. Only these routes are allowed: submit, look up, cancel, and list fills.
const ROUTES: { method: string; path: RegExp }[] = [
  { method: 'POST', path: /^\/v2\/orders$/ },
  { method: 'GET', path: /^\/v2\/orders:by_client_order_id$/ },
  { method: 'GET', path: /^\/v2\/orders\/[0-9a-f-]{36}$/ },
  { method: 'DELETE', path: /^\/v2\/orders\/[0-9a-f-]{36}$/ },
  { method: 'GET', path: /^\/v2\/account\/activities\/FILL$/ },
];

export class AlpacaHttpError extends Error {
  constructor(readonly status: number, readonly body: string, route: string) {
    super(`Alpaca ${route} failed (${status}): ${body}`);
  }
}

async function request(method: string, url: URL, credentials: AlpacaCredentials, body?: JsonObject): Promise<Response> {
  if (url.origin !== PAPER_API || !ROUTES.some(r => r.method === method && r.path.test(url.pathname))) {
    throw new Error(`Alpaca order route is not allow-listed: ${method} ${url.origin}${url.pathname}`);
  }
  const response = await fetch(url, {
    method,
    redirect: 'error',
    headers: {
      accept: 'application/json',
      ...(body ? { 'content-type': 'application/json' } : {}),
      'APCA-API-KEY-ID': credentials.apiKey,
      'APCA-API-SECRET-KEY': credentials.apiSecret,
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok && response.status !== 404) {
    const detail = (await response.text()).slice(0, 400).replace(/[\r\n]+/g, ' ');
    throw new AlpacaHttpError(response.status, detail, `${method} ${url.pathname}`);
  }
  return response;
}

export interface OrderRequest {
  symbol: string; qty: string; side: 'buy' | 'sell'; type: 'market' | 'limit'; time_in_force: 'day';
  limit_price?: string; client_order_id: string; extended_hours: false;
}

// Alpaca returns 404 for an unknown order. Right after a submission, a 404 can be a transient lag, not proof of absence.
export async function getOrderByClientId(credentials: AlpacaCredentials, clientOrderId: string): Promise<JsonObject | undefined> {
  const url = new URL('/v2/orders:by_client_order_id', PAPER_API);
  url.searchParams.set('client_order_id', clientOrderId);
  const response = await request('GET', url, credentials);
  return response.status === 404 ? undefined : object(await response.json(), 'order');
}

export async function getOrder(credentials: AlpacaCredentials, alpacaOrderId: string): Promise<JsonObject | undefined> {
  const response = await request('GET', new URL(`/v2/orders/${alpacaOrderId}`, PAPER_API), credentials);
  return response.status === 404 ? undefined : object(await response.json(), 'order');
}

// Throws AlpacaHttpError on a refusal (403 buying power or shares, 422 invalid or duplicate client order ID) and
// plain errors on timeouts or network failures, where the order may or may not exist.
export async function submitOrder(credentials: AlpacaCredentials, order: OrderRequest): Promise<JsonObject> {
  const response = await request('POST', new URL('/v2/orders', PAPER_API), credentials, { ...order });
  if (response.status === 404) throw new AlpacaHttpError(404, 'not found', 'POST /v2/orders');
  return object(await response.json(), 'order');
}

// True when Alpaca accepted the cancel request; false when the order is no longer cancelable (422).
export async function cancelOrder(credentials: AlpacaCredentials, alpacaOrderId: string): Promise<boolean> {
  try {
    await request('DELETE', new URL(`/v2/orders/${alpacaOrderId}`, PAPER_API), credentials);
    return true;
  } catch (error) {
    if (error instanceof AlpacaHttpError && error.status === 422) return false;
    throw error;
  }
}

export async function getFills(credentials: AlpacaCredentials, alpacaOrderId: string): Promise<JsonObject[]> {
  const fills: JsonObject[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 50; page++) {
    const url = new URL('/v2/account/activities/FILL', PAPER_API);
    url.searchParams.set('order_id', alpacaOrderId);
    url.searchParams.set('direction', 'asc');
    url.searchParams.set('page_size', '100');
    if (pageToken) url.searchParams.set('page_token', pageToken);
    const body: unknown = await (await request('GET', url, credentials)).json();
    if (!Array.isArray(body)) throw new Error('Alpaca returned invalid fill activities');
    const rows = body.map(row => object(row, 'fill activity'));
    fills.push(...rows);
    if (rows.length < 100) return fills;
    const next = String(rows[rows.length - 1].id ?? '');
    if (!next || next === pageToken) throw new Error('Alpaca fill pagination did not advance');
    pageToken = next;
  }
  throw new Error('Fill history exceeds the 5,000-activity safety limit');
}
