export type FilingForm = '10-K' | '10-Q' | '10-K/A' | '10-Q/A';
export type NarrativeSectionKey = 'business' | 'risk_factors' | 'management_discussion';

export interface NarrativeSection {
  key: NarrativeSectionKey;
  item: string;
  label: string;
  chunks: string[];
}

export const NARRATIVE_CHUNK_CHARS = 248;
export const NARRATIVE_CHUNKS_PER_SECTION = 3;
export const NARRATIVE_SECTION_CHARS = NARRATIVE_CHUNK_CHARS * NARRATIVE_CHUNKS_PER_SECTION;

const TARGETS: Record<'10-K' | '10-Q', { key: NarrativeSectionKey; item: string; label: string }[]> = {
  '10-K': [
    { key: 'business', item: '1', label: 'Business' },
    { key: 'risk_factors', item: '1A', label: 'Risk Factors' },
    { key: 'management_discussion', item: '7', label: "Management's Discussion and Analysis" },
  ],
  '10-Q': [
    { key: 'risk_factors', item: '1A', label: 'Risk Factors' },
    { key: 'management_discussion', item: '2', label: "Management's Discussion and Analysis" },
  ],
};

function filingFamily(form: FilingForm): '10-K' | '10-Q' {
  if (form === '10-K' || form === '10-K/A') return '10-K';
  return '10-Q';
}

const ENTITIES: Record<string, string> = {
  amp: '&', apos: "'", bull: '•', copy: '©', deg: '°', divide: '÷', emsp: ' ', ensp: ' ', gt: '>',
  hellip: '…', ldquo: '“', lsquo: '‘', lt: '<', mdash: '—', nbsp: ' ', ndash: '–', quot: '"',
  rdquo: '”', reg: '®', rsquo: '’', sect: '§', trade: '™', yen: '¥',
};

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, token: string) => {
    if (token[0] === '#') {
      const hex = token[1]?.toLowerCase() === 'x';
      const point = Number.parseInt(token.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (!Number.isFinite(point) || point < 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) return ' ';
      try { return String.fromCodePoint(point); } catch { return ' '; }
    }
    return ENTITIES[token.toLowerCase()] ?? entity;
  });
}

function htmlLines(html: string): string[] {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\s*br\b[^>]*>/gi, '\n')
    .replace(/<\s*\/\s*(?:p|div|tr|li|h[1-6]|table|section|article|body|ul|ol)\s*>/gi, '\n')
    .replace(/<\s*(?:p|div|tr|li|h[1-6]|table|section|article|ul|ol)\b[^>]*>/gi, '\n')
    .replace(/<\s*\/\s*(?:td|th)\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(text).replace(/\r/g, '\n').split('\n')
    .map(line => line.replace(/[\t\f\v ]+/g, ' ').trim())
    .filter(Boolean);
}

interface ItemHeading { item: string; line: number; title: string }

function itemHeadings(lines: string[]): ItemHeading[] {
  const headings: ItemHeading[] = [];
  for (let line = 0; line < lines.length; line++) {
    const match = /^ITEM\s+(\d+[A-Z]?)\s*[.:\-–—]?\s*(.*?)\s*$/i.exec(lines[line]);
    if (!match) continue;
    let title = match[2];
    if (!title && lines[line + 1] && lines[line + 1].length < 180) title = lines[line + 1];
    headings.push({ item: match[1].toUpperCase(), line, title });
  }
  return headings;
}

function boundedChunks(value: string): string[] {
  const text = value.slice(0, NARRATIVE_SECTION_CHARS).replace(/\s+/g, ' ').trim();
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length && chunks.length < NARRATIVE_CHUNKS_PER_SECTION) {
    if (remaining.length <= NARRATIVE_CHUNK_CHARS) {
      chunks.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf(' ', NARRATIVE_CHUNK_CHARS);
    if (cut < Math.floor(NARRATIVE_CHUNK_CHARS * 0.6)) cut = NARRATIVE_CHUNK_CHARS;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trimStart();
  }
  return chunks.filter(Boolean);
}

/** Extract short deterministic excerpts from the actual Item section body, skipping TOC-sized stubs. */
export function extractFilingNarrative(html: string, form: FilingForm): NarrativeSection[] {
  const family = filingFamily(form);
  const lines = htmlLines(html);
  const headings = itemHeadings(lines);
  const sections: NarrativeSection[] = [];
  for (const target of TARGETS[family]) {
    const candidates: { text: string; size: number }[] = [];
    for (let i = 0; i < headings.length; i++) {
      const heading = headings[i];
      if (heading.item !== target.item) continue;
      const endLine = headings[i + 1]?.line ?? lines.length;
      let startLine = heading.line + 1;
      // HTML sometimes puts the item title on the next line after its number.
      if (!heading.title && startLine < endLine && lines[startLine].length < 180) startLine++;
      const text = lines.slice(startLine, endLine).join(' ').replace(/\s+/g, ' ').trim();
      // A table-of-contents entry is usually only a title, page number, and one or two short rows.
      if (text.length >= 120) candidates.push({ text, size: text.length });
    }
    candidates.sort((a, b) => b.size - a.size);
    const chunks = candidates.length ? boundedChunks(candidates[0].text) : [];
    if (chunks.length) sections.push({ ...target, chunks });
  }
  return sections;
}

export function requiredNarrativeSections(form: FilingForm): NarrativeSectionKey[] {
  return TARGETS[filingFamily(form)].map(section => section.key);
}
