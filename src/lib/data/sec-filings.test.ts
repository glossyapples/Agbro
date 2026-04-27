// Tests for the pure parts of the SEC filings text fetcher. The
// network-fetching helpers (listFilings + fetchFilingText) are
// integration-tested by clicking Research on a watchlist symbol once
// W3 wires this in. What we pin here is HTML→text conversion + Item
// section extraction — the parsing logic where real bugs live.

import { describe, it, expect } from 'vitest';
import { htmlToText, extractItemSection } from './sec-filings';

describe('htmlToText', () => {
  it('strips tags and decodes entities', () => {
    const html = '<p>Hello <b>world</b> &amp; goodbye &nbsp;all</p>';
    const out = htmlToText(html);
    expect(out).toBe('Hello world & goodbye all');
  });

  it('preserves paragraph breaks at block-level tags', () => {
    const html = '<p>Para one.</p><p>Para two.</p>';
    expect(htmlToText(html)).toMatch(/Para one\.\s*\n+\s*Para two\./);
  });

  it('drops <script> + <style> blocks entirely (filings often have inline JS/CSS noise)', () => {
    const html = `
      <head><style>.foo{color:red}</style></head>
      <body>
        <script>var leak = "secret";</script>
        <p>Visible text.</p>
      </body>`;
    const out = htmlToText(html);
    expect(out).not.toMatch(/secret/);
    expect(out).not.toMatch(/color:red/);
    expect(out).toMatch(/Visible text\./);
  });

  it('handles XBRL-tagged HTML (the actual SEC filing format)', () => {
    const html = `
      <ix:header>
        <ix:resources>...</ix:resources>
      </ix:header>
      <body>
        <ix:nonNumeric>Revenue grew 20% YoY.</ix:nonNumeric>
      </body>`;
    const out = htmlToText(html);
    // ix:header is metadata — should be stripped.
    expect(out).not.toMatch(/ix:resources/);
    // Inline content inside ix:nonNumeric should survive the tag strip.
    expect(out).toMatch(/Revenue grew 20% YoY\./);
  });

  it('decodes numeric character references', () => {
    const html = '<p>Em dash: &#8212; Right quote: &#8217;</p>';
    const out = htmlToText(html);
    expect(out).toMatch(/Em dash: —/);
    expect(out).toMatch(/Right quote: ’/);
  });

  it('collapses runs of whitespace from indented filings (preserving paragraph breaks)', () => {
    // Multiple spaces inside a line collapse to one. Multiple newlines
    // collapse to TWO (paragraph break) so sectional structure
    // survives. This matters for the Item-section extractor downstream
    // — it relies on newline structure to find headings.
    const html = '<p>Word1     Word2\n\n\n\nWord3</p>';
    const out = htmlToText(html);
    expect(out).toBe('Word1 Word2\n\nWord3');
  });

  it('inserts breaks after table rows so cells don\'t run together', () => {
    const html = '<table><tr><td>Year</td><td>2024</td></tr><tr><td>Revenue</td><td>$2.9B</td></tr></table>';
    const out = htmlToText(html);
    expect(out).toMatch(/Year\s+2024[\s\n]+Revenue\s+\$2\.9B/);
  });
});

describe('extractItemSection', () => {
  // Synthetic 10-K skeleton — real filings are 100-300 pages but the
  // structural pattern (Item N heading → narrative → next Item) is the
  // same. The extractor must NOT match "Item 1" when looking for "1A"
  // and vice versa.
  const skeleton = `
PART I

Item 1. Business
We make titanium dioxide pigments and zircon for the global market.

Item 1A. Risk Factors
Our business is subject to commodity price cyclicality. TiO2 prices
have declined 30% over the past 18 months due to Chinese pigment
oversupply. We carry $2.9B of debt against $1.4B of equity, which
amplifies any sustained price weakness.

Item 1B. Unresolved Staff Comments
None.

Item 2. Properties
We operate plants in the US, Australia, and the Netherlands.

PART II

Item 7. Management's Discussion and Analysis
TiO2 segment revenue declined 18% in the fiscal year as global
construction activity weakened. We took a $250M impairment charge
on our Australian zircon operations.

Item 7A. Quantitative and Qualitative Disclosures About Market Risk
We hedge approximately 40% of our zircon production via long-term
contracts.

Item 8. Financial Statements and Supplementary Data
See attached statements.
`;

  it('extracts Item 1A (Risk Factors) without bleeding into Item 1 or Item 1B', () => {
    const out = extractItemSection(skeleton, '1A');
    expect(out).not.toBeNull();
    expect(out!).toMatch(/TiO2 prices\s+have declined 30%/);
    expect(out!).toMatch(/Chinese pigment\s+oversupply/);
    // Must not include the next item's text.
    expect(out!).not.toMatch(/Unresolved Staff Comments/);
    // Must not include the prior item's text.
    expect(out!).not.toMatch(/We make titanium dioxide pigments/);
  });

  it('extracts Item 7 (MD&A) without bleeding into Item 7A or Item 8', () => {
    const out = extractItemSection(skeleton, '7');
    expect(out).not.toBeNull();
    expect(out!).toMatch(/TiO2 segment revenue declined 18%/);
    expect(out!).toMatch(/\$250M impairment charge/);
    expect(out!).not.toMatch(/Quantitative and Qualitative/);
    expect(out!).not.toMatch(/Financial Statements/);
  });

  it('returns null when the requested item is not in the document', () => {
    expect(extractItemSection(skeleton, '99')).toBeNull();
  });

  it('case-insensitive on the ITEM keyword', () => {
    const upper = skeleton.replace(/Item /g, 'ITEM ');
    const out = extractItemSection(upper, '1A');
    expect(out).not.toBeNull();
    expect(out!).toMatch(/TiO2 prices/);
  });

  it('does NOT match Item 1 when asked for Item 1A (the off-by-letter trap)', () => {
    // The Item 1 (Business) section is just "We make titanium dioxide
    // pigments and zircon...". If the regex were sloppy and matched
    // "Item 1" in a search for "Item 1A", the extracted text would
    // start at the wrong place.
    const out = extractItemSection(skeleton, '1A');
    expect(out!).not.toMatch(/We make titanium dioxide pigments/);
  });

  it('handles a section that runs to end of document (no following Item)', () => {
    const truncated = `
Item 1A. Risk Factors
Some risks here.
We have many of them.
`;
    const out = extractItemSection(truncated, '1A');
    expect(out).not.toBeNull();
    expect(out!).toMatch(/We have many of them/);
  });
});
