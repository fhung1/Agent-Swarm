import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordId } from './ids.ts';

export const EXCERPT_CHARS = 3200;
type Section = 'risk_factors' | 'mda';
export interface FilingExcerpt { section: Section; text: string; startLine: number; endLine: number; charactersOmitted: number;
  startOffset: number; endOffset: number; quality: 'ok' | 'heuristic' }
export interface FilingExcerpts { version: 1; form: string; documentChecksum: string; sections: FilingExcerpt[]; missing: Section[] }
const checksum = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const SECTIONS: Section[] = ['risk_factors', 'mda'];
const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', bull: '•' };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (full, entity: string) => {
    if (!entity.startsWith('#')) return entities[entity.toLowerCase()] ?? full;
    const point = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : full;
  });
}

/** Conservative visible-text conversion for filing section detection; never executes HTML. */
export function filingText(html: string): string {
  const parts: string[] = [];
  const suppressed: string[] = [];
  const block = /^(p|div|br|hr|h[1-6]|li|tr|td|th|table|section|article)$/;
  const voidTag = /^(br|hr|img|input|meta|link|wbr|source|area|base|embed|param|col)$/;
  for (let offset = 0; offset < html.length;) {
    if (html.startsWith('<!--', offset)) { const end = html.indexOf('-->', offset + 4); offset = end < 0 ? html.length : end + 3; continue; }
    if (html[offset] !== '<') {
      const end = html.indexOf('<', offset);
      if (!suppressed.length) parts.push(decode(html.slice(offset, end < 0 ? undefined : end)));
      offset = end < 0 ? html.length : end;
      continue;
    }
    let end = offset + 1;
    let quote = '';
    for (; end < html.length; end++) {
      const char = html[end];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end === html.length) break; // Unterminated markup is not evidence text.
    const tag = html.slice(offset + 1, end);
    offset = end + 1;
    const match = tag.match(/^\s*(\/?)\s*([\w:-]+)/);
    if (!match) continue;
    const name = match[2].toLowerCase();
    if (match[1]) {
      const index = suppressed.lastIndexOf(name);
      if (index >= 0) suppressed.splice(index);
      if (!suppressed.length && block.test(name)) parts.push('\n');
    } else {
      const hidden = /^(head|script|style|noscript|svg|ix:header|ix:hidden)$/.test(name) ||
        /\bhidden(?:\s|=|$)/i.test(tag) || /\bstyle\s*=\s*["'][^"']*(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(tag);
      if ((hidden || suppressed.length) && !voidTag.test(name) && !/\/\s*$/.test(tag)) suppressed.push(name);
      if (!suppressed.length && block.test(name)) parts.push('\n');
    }
  }
  return parts.join('').replace(/\r/g, '\n').replace(/[\t \u00a0]+/g, ' ')
    .split('\n').map(line => line.trim()).filter(Boolean).join('\n');
}

export function extractFilingExcerpts(document: Buffer, form: string): FilingExcerpts {
  const result: FilingExcerpts = { version: 1, form, documentChecksum: checksum(document), sections: [], missing: [] };
  if (!['10-K', '10-Q'].includes(form) || document.length > 30 * 1024 * 1024) return { ...result, missing: [...SECTIONS] };
  const text = filingText(document.toString('utf8'));
  const headings: Record<Section, RegExp> = {
    risk_factors: /(?:^|\n)\s*item\s*1a\s*[.:–—-]?\s*risk\s+factors\b/gi,
    mda: new RegExp(`(?:^|\\n)\\s*item\\s*${form === '10-K' ? '7' : '2'}\\s*[.:–—-]?\\s*management[’']?s\\s+discussion(?:\\s+(?:and|&)\\s+analysis)?(?:\\s+of\\s+financial\\s+condition\\s+and\\s+results\\s+of\\s+operations)?`, 'gi'),
  };
  for (const section of SECTIONS) {
    const candidates: { body: string; from: number }[] = [];
    for (const match of text.matchAll(headings[section])) {
      const from = match.index + match[0].length;
      // Section boundaries use the next differently numbered item, anchored to a rendered line.
      const item = section === 'risk_factors' ? '1a' : form === '10-K' ? '7' : '2';
      const remainder = text.slice(from);
      const next = [...remainder.matchAll(/(?:^|\n)\s*item\s*(\d+[a-z]?)\s*(?:[.:–—-]|\s)/gi)]
        .find(candidate => candidate[1].toLowerCase() !== item);
      const to = next ? from + next.index : text.length;
      const raw = text.slice(from, to);
      const body = raw.trim();
      // Contents entries typically contain only a page number. Do not turn these into excerpts.
      if (body.length >= 80 && !/^\d{1,4}(?:\n|$)/.test(body)) candidates.push({ body, from: from + raw.indexOf(body) });
    }
    // Preserve the most complete body when page headers repeat the same section heading.
    const chosen = candidates.sort((a, b) => a.body.length - b.body.length || a.from - b.from).at(-1);
    if (!chosen) { result.missing.push(section); continue; }
    let clipped = chosen.body.slice(0, EXCERPT_CHARS);
    if (clipped.length < chosen.body.length) {
      const boundary = clipped.lastIndexOf(' ');
      if (boundary > EXCERPT_CHARS - 100) clipped = clipped.slice(0, boundary);
    }
    result.sections.push({ section, text: clipped, startLine: text.slice(0, chosen.from).split('\n').length,
      endLine: text.slice(0, chosen.from + clipped.length).split('\n').length, charactersOmitted: chosen.body.length - clipped.length,
      startOffset: chosen.from, endOffset: chosen.from + clipped.length, quality: candidates.length > 1 ? 'heuristic' : 'ok' });
  }
  return result;
}

export interface ExcerptSource { kind: string; symbol: string; uri: string; checksum: string; artifactRef: string }
export interface QualitativeEvidence { sections: FilingExcerpt[]; missing: string[] }

function readArtifact(root: string, requested: string, suffix: string, maxBytes: number): Buffer {
  const file = resolve(requested);
  const name = basename(file);
  if (realpathSync(dirname(file)) !== root || !new RegExp(`^[a-f0-9]{64}\\.${suffix}$`).test(name)) throw new Error('unsupported artifact path');
  if (typeof constants.O_NOFOLLOW !== 'number') throw new Error('artifact symlink protection unavailable');
  const fd = openSync(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('artifact exceeds bounds');
    const body = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < body.length) {
      const count = readSync(fd, body, offset, body.length - offset, null);
      if (!count) throw new Error('artifact changed during read');
      offset += count;
    }
    if (readSync(fd, Buffer.alloc(1), 0, 1, null)) throw new Error('artifact changed during read');
    if (checksum(body) !== name.slice(0, 64)) throw new Error('artifact checksum mismatch');
    return body;
  } finally { closeSync(fd); }
}

/** Reads only verified, content-addressed SEC artifacts within the configured directory. */
export function loadFilingExcerpts(source: ExcerptSource, artifactDir: string): QualitativeEvidence | undefined {
  if (!['10-K', '10-Q'].includes(source.kind)) return undefined;
  try {
    const root = realpathSync(artifactDir);
    const manifest = JSON.parse(readArtifact(root, fileURLToPath(source.artifactRef), 'manifest\\.json', 32_000).toString('utf8'));
    if (manifest.form !== source.kind || manifest.symbol !== source.symbol || manifest.document?.sha256 !== source.checksum ||
      manifest.document?.uri !== source.uri) throw new Error('manifest/source mismatch');
    if (!manifest.qualitativeExcerpts) {
      // Legacy sources retain their original manifest reference on idempotent re-ingestion.
      // Derive excerpts from the verified saved document without changing that source's identity.
      const document = readArtifact(root, manifest.document.path, '(?:htm|html|xhtml|txt)', 30 * 1024 * 1024);
      if (checksum(document) !== source.checksum) throw new Error('document/source mismatch');
      const legacy = extractFilingExcerpts(document, source.kind);
      return { sections: legacy.sections, missing: legacy.missing.map(section => `${section}: heading not found or insufficient section text`) };
    }
    if (!/^[a-f0-9]{64}$/.test(manifest.qualitativeExcerpts.sha256)) throw new Error('invalid excerpt reference');
    const ref = manifest.qualitativeExcerpts;
    const body = readArtifact(root, ref.path, 'excerpts\\.json', 48_000);
    if (checksum(body) !== ref.sha256) throw new Error('excerpt reference mismatch');
    const parsed = JSON.parse(body.toString('utf8')) as FilingExcerpts;
    if (parsed.version !== 1 || parsed.form !== source.kind || parsed.documentChecksum !== source.checksum ||
      !Array.isArray(parsed.sections) || parsed.sections.length > 2 || !Array.isArray(parsed.missing) ||
      parsed.sections.length + parsed.missing.length !== 2 ||
      new Set([...parsed.sections.map(row => row.section), ...parsed.missing]).size !== 2 ||
      new Set(parsed.sections.map(row => row.section)).size !== parsed.sections.length ||
      parsed.missing.some(section => !SECTIONS.includes(section)) || parsed.sections.some(row =>
        !SECTIONS.includes(row.section) || typeof row.text !== 'string' || !row.text || row.text.length > EXCERPT_CHARS ||
        !Number.isInteger(row.startLine) || row.startLine < 1 || !Number.isInteger(row.endLine) || row.endLine < row.startLine ||
        !Number.isInteger(row.startOffset) || row.startOffset < 0 || row.endOffset !== row.startOffset + row.text.length ||
        !['ok', 'heuristic'].includes(row.quality) ||
        !Number.isInteger(row.charactersOmitted) || row.charactersOmitted < 0)) throw new Error('invalid excerpt metadata');
    return { sections: parsed.sections, missing: parsed.missing.map(section => `${section}: heading not found or insufficient section text`) };
  } catch {
    return { sections: [], missing: ['Qualitative filing excerpts unavailable or failed artifact verification'] };
  }
}

export function excerptArtifactName(excerpts: FilingExcerpts): { name: string; data: string; checksum: string } {
  const data = JSON.stringify(excerpts, null, 2);
  const hash = checksum(data);
  return { name: `${hash}.excerpts.json`, data, checksum: hash };
}

export function excerptFactChunks(excerpts: FilingExcerpts, sourceId: string) {
  return excerpts.sections.flatMap(section => {
    const chunks: { id: string; section: Section; metric: string; value: string; quality: string; startOffset: number; endOffset: number }[] = [];
    let start = 0;
    for (let index = 0; index < 2 && start < section.text.length; index++) {
      while (/\s/.test(section.text[start] ?? '') && start < section.text.length) start++;
      let end = Math.min(start + 240, section.text.length);
      const space = section.text.lastIndexOf(' ', end);
      if (end < section.text.length && space > start + 180) end = space;
      const value = section.text.slice(start, end).trimEnd();
      if (!value) break;
      chunks.push({ id: recordId('', sourceId, `.excerpt.${section.section}.${index}`), section: section.section,
        metric: `excerpt.${section.section}`, value, quality: section.quality,
        startOffset: section.startOffset + start, endOffset: section.startOffset + start + value.length });
      start = end;
    }
    return chunks;
  });
}

export function verifyFilingExcerptArtifacts(artifactDir: string, manifestPath: string) {
  const root = realpathSync(artifactDir);
  const manifest = JSON.parse(readArtifact(root, manifestPath, 'manifest\\.json', 32_000).toString('utf8'));
  const source: ExcerptSource = { kind: manifest.form, symbol: manifest.symbol, uri: manifest.document?.uri,
    checksum: manifest.document?.sha256, artifactRef: `file://${resolve(manifestPath)}` };
  const loaded = loadFilingExcerpts(source, root);
  if (!loaded || loaded.missing.some(reason => reason.includes('verification'))) throw new Error('Excerpt artifact verification failed');
  const document = readArtifact(root, manifest.document.path, '(?:htm|html|xhtml|txt)', 30 * 1024 * 1024);
  if (checksum(document) !== source.checksum) throw new Error('Document/source checksum mismatch');
  const normalized = filingText(document.toString('utf8'));
  for (const row of loaded.sections) {
    if (normalized.slice(row.startOffset, row.endOffset) !== row.text) throw new Error(`Excerpt offset mismatch: ${row.section}`);
  }
  const recorded = manifest.qualitativeExcerpts?.chunks;
  if (recorded) {
    if (!Array.isArray(recorded) || typeof manifest.sourceId !== 'string') throw new Error('Invalid chunk manifest');
    const expected = excerptFactChunks({ version: 1, form: source.kind, documentChecksum: source.checksum,
      sections: loaded.sections, missing: [] }, manifest.sourceId);
    if (expected.length !== recorded.length) throw new Error('Excerpt chunk count mismatch');
    for (let index = 0; index < expected.length; index++) {
      const row = recorded[index]; const chunk = expected[index];
      if (row.id !== chunk.id || row.startOffset !== chunk.startOffset || row.endOffset !== chunk.endOffset ||
        row.sha256 !== checksum(chunk.value) || normalized.slice(row.startOffset, row.endOffset) !== chunk.value) {
        throw new Error(`Excerpt fact offset mismatch: ${chunk.id}`);
      }
    }
  }
  return { symbol: source.symbol, form: source.kind, sections: loaded.sections.length, chunks: recorded?.length ?? 0, missing: loaded.missing };
}
