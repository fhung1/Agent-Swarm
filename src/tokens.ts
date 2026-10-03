import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// One private token file per logical client keeps its SpacetimeDB identity across restarts.
export function defaultTokenFile(name: string): string {
  return path.join(os.homedir(), '.local', 'share', 'quant-swarm', 'tokens', `${name}.token`);
}

export function loadToken(file: string): string | undefined {
  try { return fs.readFileSync(file, 'utf8').trim() || undefined; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

export function saveToken(file: string, token: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, token, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
