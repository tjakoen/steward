import { test, expect } from 'bun:test';
import {
  PAGE, daysBetween, documentPrintOptions, footerTemplate,
  formatDate, formatDayMonth, formatLongDate, formatWeekdayDate,
} from './doc.ts';
import type { Client } from '../domain/types.ts';

const client = (over: Partial<Client['branding']> = {}): Client => ({
  id: 'cli_1', name: 'Acme Advisory', code: 'acme',
  branding: { logoDataUrl: null, primaryColor: '#1f4e5f', secondaryColor: '#c8a15a',
    companyInfo: '', pdfFooter: 'Acme · confidential', ...over },
  active: true, createdAt: '', updatedAt: '',
});

test('both ISO shapes format the same way; garbage passes through', () => {
  expect(formatDate('2026-07-27')).toBe('27 Jul 2026');
  expect(formatDate('2026-07-27T09:12:44.000Z')).toBe('27 Jul 2026');
  expect(formatDate('')).toBe('');
  expect(formatDate('soon')).toBe('soon');
  expect(formatDayMonth('2026-08-01')).toBe('1 Aug');
  expect(formatLongDate('2026-08-03')).toBe('3 August 2026');
});

// A bare date parsed as LOCAL time lands on the previous day west of Greenwich,
// and a digest titled with yesterday's weekday is the bug nobody reports.
test('the weekday is parsed as UTC, not as local midnight', () => {
  expect(formatWeekdayDate('2026-08-03')).toBe('Monday 3 August 2026');
  expect(formatWeekdayDate('2026-08-09')).toBe('Sunday 9 August 2026');
});

test('days between is whole days, and null when either end is unreadable', () => {
  expect(daysBetween('2026-07-27', '2026-08-03')).toBe(7);
  expect(daysBetween('2026-08-03', '2026-08-03')).toBe(0);
  expect(daysBetween('', '2026-08-03')).toBe(null);
});

/**
 * The one that shipped a nearly invisible footer: the template is a `style="…"`
 * ATTRIBUTE, so a quoted font family inside it closes the attribute and throws
 * away every declaration after it.
 */
test('no style attribute in the footer template contains a double quote', () => {
  const html = footerTemplate(client({ pdfFooter: 'He said "hello"' }));
  for (const [, value] of html.matchAll(/style="([^"]*)"/g)) {
    expect(value).not.toContain('"');
  }
  // And the attribute count is what it should be — proof the regex saw whole ones.
  expect([...html.matchAll(/style="/g)]).toHaveLength(3);
});

test('hostile footer text is escaped, not executed', () => {
  const html = footerTemplate(client({ pdfFooter: '<script>x</script>' }));
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;script&gt;');
});

test('a client with no footer text still gets the page number', () => {
  const html = footerTemplate(client({ pdfFooter: '' }));
  expect(html).toContain('class="pageNumber"');
});

test('the print options carry the margins the footer needs to fit in', () => {
  const opts = documentPrintOptions(client());
  expect(opts.margins).toEqual(PAGE);
  // Clipped to the margin: too small a bottom margin and the footer simply does
  // not appear, which reads exactly like the feature not working.
  expect(PAGE.bottom).toBeGreaterThan(PAGE.top);
});
