import { createHash } from 'node:crypto';
import { Timestamp } from 'spacetimedb';
import { DbConnection } from './module_bindings/index.js';
import { defaultTokenFile, loadToken, saveToken } from './tokens.js';

// Records clearly labeled fixture evidence so the swarm can be exercised before the SEC ingestor exists.
// Fixture sources use kind `fixture` and facts use quality `fixture`; the skeptic flags both.
const host = process.env.SPACETIMEDB_HOST ?? 'ws://localhost:3000';
const database = process.env.SPACETIMEDB_DB_NAME ?? 'quant-swarm';
const runId = process.env.RUN_ID ?? 'demo';
const symbol = (process.env.SYMBOL ?? 'AAPL').toUpperCase();
const tokenFile = process.env.SPACETIMEDB_TOKEN_FILE ?? defaultTokenFile('fixture-ingestor');

if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(runId) || !/^[A-Z][A-Z0-9.-]{0,15}$/.test(symbol)) {
  throw new Error('RUN_ID or SYMBOL has invalid characters');
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

// Treat "already exists" as success so the script can be rerun for the same run and symbol.
async function idempotent(label: string, call: () => Promise<void>): Promise<void> {
  try { await call(); console.log(`Recorded ${label}`); }
  catch (error) {
    if (!String(error).includes('already exists')) throw error;
    console.log(`${label} already recorded`);
  }
}

async function main(): Promise<void> {
  const conn = await connectDatabase();
  try {
    if (process.argv.includes('--register')) {
      console.log('Registered fixture ingestor identity. Grant it the ingestor role before recording evidence.');
      return;
    }
    const prefix = `fixture.${runId}.${symbol}`;
    const asOf = Timestamp.fromDate(new Date());
    const sources = [
      { id: `${prefix}.filing`, kind: 'fixture', uri: `fixture://quant-swarm/${symbol}/filing` },
      { id: `${prefix}.transcript`, kind: 'fixture', uri: `fixture://quant-swarm/${symbol}/transcript` },
    ];
    for (const source of sources) {
      await idempotent(source.id, () => conn.reducers.addSource({
        ...source, runId, symbol, asOf,
        checksum: createHash('sha256').update(source.uri).digest('hex'), artifactRef: '',
      }));
    }
    const facts = [
      { id: `${prefix}.revenue`, sourceId: sources[0].id, metric: 'revenue', value: '0', unit: 'USD' },
      { id: `${prefix}.guidance`, sourceId: sources[1].id, metric: 'guidance_change', value: 'none', unit: 'label' },
    ];
    for (const fact of facts) {
      await idempotent(fact.id, () => conn.reducers.addFact({ ...fact, symbol, period: 'fixture', quality: 'fixture' }));
    }
  } finally {
    conn.disconnect();
  }
}

void main().catch(error => {
  console.error(`Fixture ingest failed: ${String(error)}`);
  process.exitCode = 1;
});
