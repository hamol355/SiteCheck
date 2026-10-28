import { describe, expect, it } from 'vitest';
import { renderJson } from '../src/output/json.js';
import { renderTerminal, shouldUseColor } from '../src/output/terminal.js';
import type { Report } from '../src/report.js';

const report: Report = {
  schemaVersion: 1,
  url: 'http://example.com/',
  finalUrl: 'https://example.com/',
  score: 77,
  grade: 'Good',
  categories: {
    availability: { score: 15, max: 15 },
    security: { score: 30, max: 35 },
    seo: { score: 15, max: 20 },
    accessibility: { score: 12, max: 30 },
  },
  checks: [
    {
      id: 'http-status',
      category: 'availability',
      status: 'pass',
      message: 'Responded with HTTP 200',
      points: 8,
      maxPoints: 8,
    },
    {
      id: 'content-security-policy',
      category: 'security',
      status: 'fail',
      message: 'Missing Content-Security-Policy header',
      remediation: "Add header: Content-Security-Policy: default-src 'self'",
      points: 0,
      maxPoints: 8,
    },
    {
      id: 'h1',
      category: 'seo',
      status: 'warn',
      message: 'Page has 2 <h1> elements',
      remediation: 'Use a single <h1>.',
      points: 1,
      maxPoints: 3,
    },
    {
      id: 'html-lang',
      category: 'accessibility',
      status: 'error',
      message: 'Check failed to run: boom',
      points: 0,
      maxPoints: 5,
    },
  ],
  meta: {
    sitecheckVersion: '0.1.0',
    analyzedAt: '2026-01-01T00:00:00.000Z',
    responseTimeMs: 12,
    truncated: false,
  },
};

describe('renderTerminal', () => {
  const out = renderTerminal(report);

  it('groups checks by category with category scores', () => {
    const order = [
      'Availability (15/15)',
      'Security (30/35)',
      'SEO (15/20)',
      'Accessibility (not checked)',
    ].map((title) => out.indexOf(title));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('shows a symbol per status', () => {
    expect(out).toContain('✓ Responded with HTTP 200');
    expect(out).toContain('✗ Missing Content-Security-Policy header');
    expect(out).toContain('⚠ Page has 2 <h1> elements');
    expect(out).toContain('✗ Check failed to run: boom');
  });

  it('shows remediation only for non-passing checks', () => {
    expect(out).toContain("→ Add header: Content-Security-Policy: default-src 'self'");
    expect(out).toContain('→ Use a single <h1>.');
    expect(out.match(/→/g)).toHaveLength(2);
  });

  it('shows the URL, final URL and total score with grade', () => {
    expect(out).toContain('URL: http://example.com/');
    expect(out).toContain('Final URL: https://example.com/');
    expect(out).toContain('Score: 77/100 (Good)');
  });

  it('shows the WCAG references of a check', () => {
    const check = { ...report.checks[0]!, wcag: ['2.4.4', '4.1.2'] };
    expect(renderTerminal({ ...report, checks: [check] })).toContain(
      '✓ Responded with HTTP 200 (WCAG 2.4.4, 4.1.2)',
    );
    expect(out).not.toContain('WCAG');
  });

  it('shows skipped checks with a dash', () => {
    const check = { ...report.checks[0]!, status: 'skip' as const, message: 'Skipped: x' };
    expect(renderTerminal({ ...report, checks: [check] })).toContain('  – Skipped: x');
  });

  it('notes when the page was truncated', () => {
    expect(out).not.toContain('Note:');
    const truncated = renderTerminal({ ...report, meta: { ...report.meta, truncated: true } });
    expect(truncated).toContain('only its beginning was analysed');
  });

  it('omits the final URL when it equals the URL', () => {
    expect(renderTerminal({ ...report, finalUrl: report.url })).not.toContain('Final URL');
  });

  it('escapes control characters in messages and remediation', () => {
    const check = { ...report.checks[0]!, status: 'warn' as const };
    const out = renderTerminal({
      ...report,
      checks: [{ ...check, message: 'a\x1b[2Jb', remediation: 'c\x1b]0;x\x07' }],
    });
    expect(out).not.toContain('\x1b');
    expect(out).toContain('a\\x1b[2Jb');
    expect(out).toContain('c\\x1b]0;x\\x07');
  });

  it('has no ANSI escapes by default and adds them with color', () => {
    expect(out).not.toContain('\x1b[');
    expect(renderTerminal(report, { color: true })).toContain('\x1b[32m✓\x1b[0m');
  });
});

describe('shouldUseColor', () => {
  it('requires a TTY and no NO_COLOR', () => {
    expect(shouldUseColor({}, true)).toBe(true);
    expect(shouldUseColor({}, false)).toBe(false);
    expect(shouldUseColor({ NO_COLOR: '1' }, true)).toBe(false);
    expect(shouldUseColor({ NO_COLOR: '' }, true)).toBe(true);
  });
});

describe('renderJson', () => {
  it('round-trips the report and ends with a newline', () => {
    const json = renderJson(report);
    expect(json.endsWith('\n')).toBe(true);
    expect(JSON.parse(json)).toEqual(report);
  });

  it('exposes the documented top-level fields', () => {
    expect(Object.keys(JSON.parse(renderJson(report)))).toEqual([
      'schemaVersion',
      'url',
      'finalUrl',
      'score',
      'grade',
      'categories',
      'checks',
      'meta',
    ]);
  });
});

describe('renderTerminal with several pages', () => {
  const page = (n: number, status: 'pass' | 'fail') => ({
    url: `https://example.com/p${n}`,
    status: 200,
    checks: [{ id: 'h1', status, message: 'h1' }],
  });
  const multi: Report = {
    ...report,
    pages: [
      page(0, 'pass'),
      page(1, 'fail'),
      page(2, 'fail'),
      page(3, 'fail'),
      page(4, 'fail'),
      { url: 'https://example.com/gone', status: null, skipped: 'Timed out', checks: [] },
    ],
    meta: { ...report.meta, pagesAnalyzed: 5 },
  };

  it('lists the first three affected URLs, a remainder and skipped pages', () => {
    const out = renderTerminal(multi);
    expect(out).toContain('Pages analysed: 5 (1 skipped)');
    expect(out).toContain('https://example.com/gone: Timed out');
    expect(out).toContain('    https://example.com/p1\n');
    expect(out).toContain('    https://example.com/p3\n');
    expect(out).not.toContain('    https://example.com/p4\n');
    expect(out).toContain('    +1 more');
  });

  it('prints no page section for a single-page report', () => {
    expect(renderTerminal(report)).not.toContain('Pages analysed');
  });
});
