import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { verifyFilingExcerptArtifacts } from '../src/sec-excerpts.ts';

const directory = process.argv[2] ?? process.env.SEC_ARTIFACT_DIR ?? join(homedir(), '.local/share/quant-swarm/artifacts/sec');
const manifests = readdirSync(directory).filter(name => name.endsWith('.manifest.json'));
if (!manifests.length) throw new Error('No saved SEC filing manifests found');
for (const name of manifests) console.log(JSON.stringify(verifyFilingExcerptArtifacts(directory, join(directory, name))));
console.log(`Verified ${manifests.length} saved filing manifests against original documents; no network calls.`);
