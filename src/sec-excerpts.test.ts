import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { EXCERPT_CHARS, extractFilingExcerpts, excerptArtifactName, excerptFactChunks, filingText, loadFilingExcerpts,
  verifyFilingExcerptArtifacts } from './sec-excerpts.ts';

const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const risk = 'Supplier concentration could disrupt production and lower revenue. Demand uncertainty could affect margins. ';
const mda = 'Operating revenue increased while input costs rose, and cash flow funded capital expenditure. ';
function filing(form = '10-K', long = false): Buffer {
  const item = form === '10-K' ? '7' : '2';
  return Buffer.from(`<html><head><title>Hidden title</title></head><body>
    <p>Table of contents</p><p>Item 1A. Risk Factors</p><p>12</p><p>Item 1B. Other</p>
    <p>Item ${item}. Management’s Discussion and Analysis</p><p>25</p><p>Item ${item}A. Other</p>
    <h2>Item 1A. Risk Factors</h2><p>${risk.repeat(long ? 60 : 2)}</p><h2>Item 1B. Other</h2><p>Excluded unrelated disclosure.</p>
    <h2>Item ${item}. Management’s Discussion and Analysis of Financial Condition and Results of Operations</h2>
    <p>${mda.repeat(long ? 60 : 2)}</p><h2>Item ${form === '10-K' ? '7A' : '3'}. Other</h2><p>Excluded market risks.</p>
    </body></html>`);
}

function saved(t: TestContext, legacy = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sec-excerpt-test-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const document = filing();
  const documentHash = hash(document);
  const documentPath = join(root, `${documentHash}.htm`);
  writeFileSync(documentPath, document);
  const excerpts = extractFilingExcerpts(document, '10-K');
  const artifact = excerptArtifactName(excerpts);
  const excerptPath = join(root, artifact.name);
  writeFileSync(excerptPath, artifact.data);
  const uri = 'https://www.sec.gov/Archives/edgar/data/1/000000000126000001/fixture.htm';
  const manifest = { sourceId: 'fixture-source', form: '10-K', symbol: 'QTEST', document: { sha256: documentHash, uri, path: documentPath },
    ...(legacy ? {} : { qualitativeExcerpts: { sha256: artifact.checksum, path: excerptPath,
      chunks: excerptFactChunks(excerpts,'fixture-source').map(({value,...chunk})=>({...chunk,sha256:hash(value)})) } }) };
  const text = JSON.stringify(manifest);
  const manifestPath = join(root, `${hash(text)}.manifest.json`);
  writeFileSync(manifestPath, text);
  return { root, manifest, manifestPath, excerptPath, documentPath, excerpts,
    source: { kind: '10-K', symbol: 'QTEST', uri, checksum: documentHash, artifactRef: pathToFileURL(manifestPath).href } };
}

test('HTML text excludes hidden/script/XBRL context and preserves visible entities and quoted attributes', () => {
  const text = filingText(`<head>HEAD</head><script>SECRET</script><style>CSS</style><ix:hidden>XBRL</ix:hidden>
    <div hidden><div>INVISIBLE</div>STILL HIDDEN</div><div style="display: none">HIDDEN STYLE</div>
    <p title="one > zero">Revenue &amp; costs: &#233; &#x2019; &nbsp; visible<span> text</span>.</p>`);
  assert.equal(text, 'Revenue & costs: é ’ visible text.');
});

test('annual and quarterly body headings beat contents entries and end at the next item', () => {
  for (const form of ['10-K', '10-Q']) {
    const result = extractFilingExcerpts(filing(form), form);
    assert.deepEqual(result.missing, []);
    assert.deepEqual(result.sections.map(section => section.section), ['risk_factors', 'mda']);
    assert.equal(result.sections[0].text, risk.repeat(2).trim());
    assert.equal(result.sections[1].text, mda.repeat(2).trim());
    assert(!result.sections.some(section => section.text.includes('Excluded')));
    const lines = filingText(filing(form).toString()).split('\n');
    for (const section of result.sections) assert.equal(lines.slice(section.startLine - 1, section.endLine).join('\n'), section.text);
  }
});

test('trimmed real AAPL annual and quarterly filings yield stable risk and MD&A excerpts',()=>{
  for(const form of ['10-k','10-q']) {
    const document=readFileSync(new URL(`../fixtures/sec/aapl-${form}.html`,import.meta.url));
    const expected=JSON.parse(readFileSync(new URL(`../fixtures/sec/aapl-${form}.json`,import.meta.url),'utf8'));
    const result=extractFilingExcerpts(document,expected.form);
    assert.equal(result.sections[0].text,expected.riskFactors.trim());
    assert.equal(result.sections[1].text,expected.mda.trim());
    assert.deepEqual(result,extractFilingExcerpts(document,expected.form));
    assert.deepEqual(result.missing,[]);
  }
});

test('fact chunks fit the module bounds, preserve document offsets, and keep stable unique IDs',()=>{
  const document=filing('10-K',true);
  const excerpts=extractFilingExcerpts(document,'10-K');
  const normalized=filingText(document.toString());
  const chunks=excerptFactChunks(excerpts,'source.'+'x'.repeat(120));
  assert.equal(chunks.length,4);
  assert.equal(new Set(chunks.map(c=>c.id)).size,4);
  assert.deepEqual(chunks,excerptFactChunks(excerpts,'source.'+'x'.repeat(120)));
  for(const chunk of chunks) {
    assert.ok(chunk.id.length<=128);
    assert.ok(chunk.value.length>0&&chunk.value.length<=240);
    assert.equal(normalized.slice(chunk.startOffset,chunk.endOffset),chunk.value);
  }
});

test('excerpts are verbatim normalized prefixes with explicit truncation and checksum', () => {
  const document = filing('10-K', true);
  const result = extractFilingExcerpts(document, '10-K');
  assert.equal(result.documentChecksum, hash(document));
  for (const [index, row] of result.sections.entries()) {
    const full = (index === 0 ? risk : mda).repeat(60).trim();
    assert(row.text.length <= EXCERPT_CHARS);
    assert(full.startsWith(row.text));
    assert.equal(row.charactersOmitted, full.length - row.text.length);
  }
});

test('missing/contents-only headings and unsupported forms are explicit and never fabricated', () => {
  for (const document of [Buffer.from('<p>No requested sections.</p>'),
    Buffer.from('<p>Item 1A Risk Factors</p><p>12</p><p>Item 7 Management’s Discussion and Analysis</p><p>25</p>')]) {
    const result = extractFilingExcerpts(document, '10-K');
    assert.deepEqual(result.sections, []);
    assert.deepEqual(result.missing, ['risk_factors', 'mda']);
  }
  assert.deepEqual(extractFilingExcerpts(filing(), '8-K').sections, []);
});

test('verified manifest/excerpt artifacts load; legacy manifests derive the same text from saved documents', t => {
  for (const legacy of [false, true]) {
    const f = saved(t, legacy);
    assert.deepEqual(loadFilingExcerpts(f.source, f.root), { sections: f.excerpts.sections, missing: [] });
    assert.equal(verifyFilingExcerptArtifacts(f.root,f.manifestPath).sections,2);
  }
});

test('offset verification rejects a manifest whose excerpt fact offsets were changed',t=>{
  const f=saved(t);
  f.manifest.qualitativeExcerpts!.chunks[0].startOffset++;
  const text=JSON.stringify(f.manifest);
  const file=join(f.root,`${hash(text)}.manifest.json`);
  writeFileSync(file,text);
  assert.throws(()=>verifyFilingExcerptArtifacts(f.root,file),/fact offset mismatch/);
});

test('artifact corruption and source mismatch make qualitative evidence explicitly unavailable', t => {
  const f = saved(t);
  for (const change of [{ checksum: '0'.repeat(64) }, { symbol: 'OTHER' }, { uri: 'fixture://wrong' }]) {
    const result = loadFilingExcerpts({ ...f.source, ...change }, f.root);
    assert.deepEqual(result?.sections, []);
    assert.match(result!.missing[0], /unavailable/);
  }
  writeFileSync(f.excerptPath, '{}');
  assert.deepEqual(loadFilingExcerpts(f.source, f.root)?.sections, []);
});

test('outside-directory and symlink paths cannot be read into model evidence', t => {
  const f = saved(t);
  const outside = saved(t);
  assert.deepEqual(loadFilingExcerpts(outside.source, f.root)?.sections, []);
  rmSync(f.excerptPath);
  symlinkSync(outside.excerptPath, f.excerptPath);
  assert.deepEqual(loadFilingExcerpts(f.source, f.root)?.sections, []);
});

test('a corrupted legacy filing is not used even when its manifest remains valid', t => {
  const f = saved(t, true);
  writeFileSync(f.documentPath, filing('10-Q'));
  assert.deepEqual(loadFilingExcerpts(f.source, f.root)?.sections, []);
});
