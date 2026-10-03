import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractFilingNarrative, NARRATIVE_CHUNK_CHARS, NARRATIVE_SECTION_CHARS, requiredNarrativeSections,
} from './sec-narrative.ts';

const p = (value: string) => `<p>${value}</p>`;
const filler = (value: string) => Array.from({ length: 15 }, (_, i) => `${value} ${i + 1}.`).join(' ');

test('10-K extraction chooses substantive filing bodies over table-of-contents rows', () => {
  const html = [
    p('Table of Contents'),
    ...[
      'Item 1. Business 3', 'Item 1A. Risk Factors 8', 'Item 1B. Unresolved Staff Comments 17',
      'Item 2. Properties 17', 'Item 3. Legal Proceedings 18', 'Item 4. Mine Safety 18',
      'Item 5. Market for Registrant Common Equity 19', 'Item 6. Reserved 20',
      "Item 7. Management's Discussion and Analysis 21", 'Item 8. Financial Statements 42',
      'Item 9. Changes in Accountants 71', 'Item 9A. Controls and Procedures 71',
    ].map(p),
    p('ITEM 1. BUSINESS'), p(`ACTUAL BUSINESS ${filler('operations and products')}`),
    p('ITEM 1A. RISK FACTORS'), p(`ACTUAL RISK FACTORS ${filler('material risk disclosure')}`),
    p("ITEM 7. MANAGEMENT'S DISCUSSION AND ANALYSIS"), p(`ACTUAL MANAGEMENT DISCUSSION ${filler('quarterly trends and liquidity')}`),
  ].join('\n');

  const sections = extractFilingNarrative(html, '10-K');
  assert.deepEqual(sections.map(section => section.key), ['business', 'risk_factors', 'management_discussion']);
  for (const section of sections) {
    const excerpt = section.chunks.join(' ');
    assert.match(excerpt, /ACTUAL/);
    assert.doesNotMatch(excerpt, /Table of Contents|Unresolved Staff Comments/);
    assert.ok(section.chunks.length <= 3);
    assert.ok(section.chunks.every(chunk => chunk.length <= NARRATIVE_CHUNK_CHARS));
    assert.ok(excerpt.length <= NARRATIVE_SECTION_CHARS);
  }
  assert.match(sections[0].chunks.join(' '), /ACTUAL BUSINESS/);
  assert.match(sections[1].chunks.join(' '), /ACTUAL RISK FACTORS/);
  assert.match(sections[2].chunks.join(' '), /ACTUAL MANAGEMENT DISCUSSION/);
});

test('10-Q extraction maps Part I Item 2 and Part II Item 1A to required narrative sections', () => {
  const html = [
    p('Table of Contents'), p('Part I Financial Information'), p('Item 1. Financial Statements 3'),
    p('Item 2. Management Discussion 9'), p('Item 3. Quantitative Disclosures 16'),
    p('Part II Other Information'), p('Item 1. Legal Proceedings 19'), p('Item 1A. Risk Factors 20'),
    p('ITEM 2. MANAGEMENT\'S DISCUSSION AND ANALYSIS'), p(`QUARTERLY MANAGEMENT ${filler('cash flow and results')}`),
    p('ITEM 1A. RISK FACTORS'), p(`QUARTERLY RISK ${filler('uncertainty and risk exposure')}`),
  ].join('\n');
  const sections = extractFilingNarrative(html, '10-Q');
  assert.deepEqual(sections.map(section => section.key), ['risk_factors', 'management_discussion']);
  assert.match(sections.find(section => section.key === 'risk_factors')!.chunks.join(' '), /QUARTERLY RISK/);
  assert.match(sections.find(section => section.key === 'management_discussion')!.chunks.join(' '), /QUARTERLY MANAGEMENT/);
  assert.deepEqual(requiredNarrativeSections('10-Q'), ['risk_factors', 'management_discussion']);
});

test('amended forms use their family section rules and preserve the full required disclosure test', () => {
  const annual = [p('ITEM 1. BUSINESS'), p(`AMENDED BUSINESS ${filler('products and operations')}`),
    p('ITEM 1A. RISK FACTORS'), p(`AMENDED RISK ${filler('material company risk')}`),
    p("ITEM 7. MANAGEMENT'S DISCUSSION AND ANALYSIS"), p(`AMENDED MANAGEMENT ${filler('results and liquidity')}`)].join('\n');
  const quarterly = [p('ITEM 2. MANAGEMENT\'S DISCUSSION AND ANALYSIS'), p(`AMENDED QUARTER ${filler('results and cash flow')}`),
    p('ITEM 1A. RISK FACTORS'), p(`AMENDED RISK ${filler('uncertainty and risk')}`)].join('\n');
  assert.deepEqual(extractFilingNarrative(annual, '10-K/A').map(section => section.key),
    ['business','risk_factors','management_discussion']);
  assert.deepEqual(extractFilingNarrative(quarterly, '10-Q/A').map(section => section.key),
    ['risk_factors','management_discussion']);
  assert.deepEqual(requiredNarrativeSections('10-K/A'), requiredNarrativeSections('10-K'));
  assert.deepEqual(requiredNarrativeSections('10-Q/A'), requiredNarrativeSections('10-Q'));
});

test('HTML scripts are excluded and common SEC entities become readable text', () => {
  const html = [
    p('ITEM 1. BUSINESS'),
    `<p>Company&nbsp;operations &amp; products &#8217; create material &#x2014; value.</p>`,
    '<script>ITEM 1A. fake section should not count</script>',
    p(`ACTUAL ${filler('business evidence')}`),
    p('ITEM 1A. RISK FACTORS'), p(`ACTUAL ${filler('risk disclosure')}`),
    p("ITEM 7. MANAGEMENT'S DISCUSSION AND ANALYSIS"), p(`ACTUAL ${filler('management discussion')}`),
  ].join('\n');
  const sections = extractFilingNarrative(html, '10-K');
  assert.equal(sections.length, 3);
  assert.match(sections[0].chunks.join(' '), /Company operations & products ’ create material — value/);
  assert.doesNotMatch(sections.map(section => section.chunks.join(' ')).join(' '), /fake section/);
});
