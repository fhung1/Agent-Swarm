import { filingText } from './sec-excerpts.ts';

export type FilingForm = '10-K' | '10-Q' | '10-K/A' | '10-Q/A' | '8-K' | '8-K/A';
export interface SecFilingRow {
  form: string; accession: string; filingDate: string; reportDate: string; acceptedAt: string;
  primaryDocument: string; items?: string;
}
export interface SelectedSecFiling extends SecFilingRow { form: FilingForm; itemCodes: string[]; supersedesAccession?: string }
export interface EightKExcerpt { item: string; text: string; charactersOmitted: number }

export const SEC_UPDATE_LIMITS = {
  amendmentsPerFamily: 2,
  relevantEightK: 2,
  excerptItems: 2,
  excerptCharacters: 1200,
  factChunkCharacters: 240,
} as const;

const REPORT_FORMS = ['10-K', '10-Q'] as const;
const MATERIAL_EIGHT_K_ITEMS = new Set(['1.01', '2.02', '4.02', '8.01']);
const formFamily = (form: string): '10-K' | '10-Q' | undefined =>
  form === '10-K' || form === '10-K/A' ? '10-K' : form === '10-Q' || form === '10-Q/A' ? '10-Q' : undefined;
const dateValue = (value: string) => Date.parse(value);
const validIsoDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const byAcceptance = (a: SecFilingRow, b: SecFilingRow) =>
  dateValue(b.acceptedAt) - dateValue(a.acceptedAt) || a.accession.localeCompare(b.accession);

function itemsFor(value: string | undefined): string[] {
  return [...new Set((value ?? '').split(',').map(item => item.trim()).filter(item => MATERIAL_EIGHT_K_ITEMS.has(item)))].sort();
}

function validRow(row: SecFilingRow): boolean {
  return /^[0-9]{10}-[0-9]{2}-[0-9]{6}$/.test(row.accession) &&
    /^[A-Za-z0-9._-]+$/.test(row.primaryDocument) &&
    Number.isFinite(dateValue(row.acceptedAt)) && Number.isFinite(dateValue(row.filingDate)) &&
    (validIsoDate(row.filingDate) && (row.reportDate === '' || validIsoDate(row.reportDate)));
}

/** Choose a bounded, stable set. Keep the latest original filings, recent amendments, and material 8-K updates. */
export function selectSecFilings(rows: readonly SecFilingRow[], nowMs = Date.now()): SelectedSecFiling[] {
  const valid = rows.filter(validRow).filter(row =>
    ['10-K', '10-Q', '10-K/A', '10-Q/A', '8-K', '8-K/A'].includes(row.form));
  const selected: SelectedSecFiling[] = [];
  const push = (row: SecFilingRow, supersedesAccession?: string) => {
    selected.push({ ...row, form: row.form as FilingForm, itemCodes: itemsFor(row.items),
      ...(supersedesAccession ? { supersedesAccession } : {}) });
  };

  for (const family of REPORT_FORMS) {
    const original = valid.filter(row => row.form === family && row.reportDate)
      .sort((a, b) => b.reportDate.localeCompare(a.reportDate) || byAcceptance(a, b))[0];
    if (original) push(original);
    const amendments = valid.filter(row => row.form === `${family}/A` && row.reportDate &&
      nowMs - dateValue(row.acceptedAt) >= 0 && nowMs - dateValue(row.acceptedAt) <= 730 * 86_400_000).sort(byAcceptance)
      .slice(0, SEC_UPDATE_LIMITS.amendmentsPerFamily);
    for (const amendment of amendments) {
      const previous = valid.filter(row => formFamily(row.form) === family && row.reportDate === amendment.reportDate &&
        dateValue(row.acceptedAt) < dateValue(amendment.acceptedAt)).sort(byAcceptance)[0];
      push(amendment, previous?.accession);
    }
  }

  const events = valid.filter(row => (row.form === '8-K' || row.form === '8-K/A') && itemsFor(row.items).length > 0 &&
    nowMs - dateValue(row.acceptedAt) >= 0 && nowMs - dateValue(row.acceptedAt) <= 365 * 86_400_000).sort(byAcceptance).slice(0, SEC_UPDATE_LIMITS.relevantEightK);
  for (const event of events) push(event);
  return selected.sort((a, b) => dateValue(a.acceptedAt) - dateValue(b.acceptedAt) || a.accession.localeCompare(b.accession));
}

/** A 10-Q cash-flow fact is quarterly only when its reported duration is about one fiscal quarter. */
export function isStandaloneQuarterDuration(start: string | undefined, end: string): boolean {
  if (!start || !validIsoDate(start) || !validIsoDate(end)) return false;
  const days = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000;
  return days >= 70 && days <= 110;
}

/** Extract only material 8-K item bodies named by submissions metadata and cap both text and facts. */
export function extractEightKExcerpts(html: string, selectedItems: readonly string[]): EightKExcerpt[] {
  if (html.length > 30 * 1024 * 1024) return [];
  const lines = filingText(html).split('\n');
  const headings: { item: string; line: number }[] = [];
  for (let line = 0; line < lines.length; line++) {
    const match = /^item\s+(\d+\.\d+)\b/i.exec(lines[line]);
    if (match) headings.push({ item: match[1], line });
  }
  const result: EightKExcerpt[] = [];
  for (const item of itemsFor(selectedItems.join(',')).slice(0, SEC_UPDATE_LIMITS.excerptItems)) {
    const candidates: string[] = [];
    for (let index = 0; index < headings.length; index++) {
      const heading = headings[index];
      if (heading.item !== item) continue;
      const end = headings[index + 1]?.line ?? lines.length;
      const body = lines.slice(heading.line + 1, end).join(' ').replace(/\s+/g, ' ').trim();
      if (body.length >= 100) candidates.push(body);
    }
    candidates.sort((a, b) => b.length - a.length || a.localeCompare(b));
    const body = candidates[0];
    if (!body) continue;
    const clipped = body.slice(0, SEC_UPDATE_LIMITS.excerptCharacters);
    result.push({ item, text: clipped, charactersOmitted: body.length - clipped.length });
  }
  return result;
}

export function splitEventFact(value: string): string[] {
  const chunks: string[] = [];
  let remaining = value.trim();
  while (remaining && chunks.length < 2) {
    if (remaining.length <= SEC_UPDATE_LIMITS.factChunkCharacters) {
      chunks.push(remaining);
      break;
    }
    let boundary = remaining.lastIndexOf(' ', SEC_UPDATE_LIMITS.factChunkCharacters);
    if (boundary < SEC_UPDATE_LIMITS.factChunkCharacters * 0.6) boundary = SEC_UPDATE_LIMITS.factChunkCharacters;
    chunks.push(remaining.slice(0, boundary).trim());
    remaining = remaining.slice(boundary).trimStart();
  }
  return chunks;
}
