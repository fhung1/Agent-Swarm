import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DbConnection } from './module_bindings/index.js';
import {
  amountField, credentialsFromEnv, getAccount, getLatestQuotes, getOpenOrders, getPositions, object, parseFeed,
  parseQuote, requiredEnv, textField, type Feed,
} from './alpaca-client.js';

const host = process.env.SPACETIMEDB_HOST ?? 'ws://localhost:3000';
const database = process.env.SPACETIMEDB_DB_NAME ?? 'quant-swarm';
const tokenFile = process.env.SPACETIMEDB_TOKEN_FILE ??
  path.join(os.homedir(), '.local', 'share', 'quant-swarm', 'tokens', 'alpaca-reader.token');

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

function observation(symbol: string, raw: unknown, snapshotId: string, feed: Feed) {
  return { id: `${snapshotId}.${symbol}`, feed, ...parseQuote(symbol, raw) };
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

    const credentials = credentialsFromEnv();
    const feed = parseFeed(requiredEnv('ALPACA_DATA_FEED'));
    const symbols = parseSymbols(requiredEnv('ALPACA_SYMBOLS'));

    // The trading origin is fixed to Alpaca's paper API. All broker and market requests use GET.
    const [accountRaw, positionsRaw, ordersRaw, quotesRaw] = await Promise.all([
      getAccount(credentials),
      getPositions(credentials),
      getOpenOrders(credentials),
      getLatestQuotes(credentials, symbols, feed),
    ]);

    const account = object(accountRaw, 'account');
    if (!Array.isArray(positionsRaw) || !Array.isArray(ordersRaw)) throw new Error('Alpaca returned invalid positions or orders');
    const quoteResponse = object(quotesRaw, 'latest quotes');
    const quoteMap = object(quoteResponse.quotes, 'latest quotes map');
    const snapshotId = randomUUID();
    const observations = symbols.map(symbol => {
      const quote = quoteMap[symbol];
      if (!quote) throw new Error(`Alpaca returned no latest quote for ${symbol}`);
      return observation(symbol, quote, snapshotId, feed);
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

void main().catch(error => {
  console.error(`Read-only Alpaca snapshot failed: ${String(error)}`);
  process.exitCode = 1;
});
