import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractEightKExcerpts, isStandaloneQuarterDuration, selectSecFilings, splitEventFact } from './sec-updates.ts';

const row = (form: string, accession: string, reportDate: string, acceptedAt: string, items = '') => ({
  form, accession, filingDate: acceptedAt.slice(0, 10), reportDate, acceptedAt,
  primaryDocument: 'filing.htm', items,
});

test('filing selection is bounded, stable and links an amendment to its prior accession', () => {
  const rows = [
    row('10-K', '0000000001-25-000001', '2024-12-31', '2025-02-01T12:00:00Z'),
    row('10-K/A', '0000000001-25-000002', '2024-12-31', '2025-02-05T12:00:00Z'),
    row('10-Q', '0000000001-26-000001', '2026-06-30', '2026-08-01T12:00:00Z'),
    ...Array.from({ length: 4 }, (_, index) => row('10-K/A', `0000000001-26-${String(index + 2).padStart(6, '0')}`,
      '2024-12-31', `2026-0${index + 1}-01T12:00:00Z`)),
    row('8-K', '0000000001-26-000010', '', '2026-09-20T12:00:00Z', '2.02,4.02,9.99'),
    row('8-K', '0000000001-26-000011', '', '2026-09-21T12:00:00Z', '8.01'),
    row('8-K/A', '0000000001-26-000012', '', '2026-09-22T12:00:00Z', '1.01'),
  ];
  const chosen = selectSecFilings(rows, Date.parse('2026-10-01T00:00:00Z'));
  assert.deepEqual(chosen.map(filing => filing.accession), [
    '0000000001-25-000001', '0000000001-26-000004', '0000000001-26-000005',
    '0000000001-26-000001', '0000000001-26-000011', '0000000001-26-000012',
  ]);
  assert.equal(chosen[1].supersedesAccession, '0000000001-26-000003');
  assert.deepEqual(chosen[4].itemCodes, ['8.01']);
  assert.deepEqual(selectSecFilings([...rows].reverse(), Date.parse('2026-10-01T00:00:00Z')), chosen);
});

test('a 10-Q quarterly flow accepts standalone quarter duration and rejects YTD', () => {
  assert.equal(isStandaloneQuarterDuration('2026-04-01', '2026-06-30'), true);
  assert.equal(isStandaloneQuarterDuration('2026-01-01', '2026-06-30'), false);
  assert.equal(isStandaloneQuarterDuration(undefined, '2026-06-30'), false);
});

test('8-K extraction follows selected material items and caps excerpts and fact chunks', () => {
  const body = 'The company reports a material operating update and provides details to investors. '.repeat(40);
  const html = `<h2>Item 2.02 Results</h2><p>${body}</p><h2>Item 4.02 Non-Reliance</h2><p>${body}</p>`;
  const excerpts = extractEightKExcerpts(html, ['2.02', '4.02', '8.01']);
  assert.deepEqual(excerpts.map(item => item.item), ['2.02', '4.02']);
  assert.ok(excerpts.every(item => item.text.length <= 1200 && item.charactersOmitted > 0));
  assert.ok(splitEventFact(excerpts[0].text).length <= 2);
  assert.ok(splitEventFact(excerpts[0].text).every(chunk => chunk.length <= 240));
});
