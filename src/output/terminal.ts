import type { Category, Status } from '../checks/types.js';
import type { Report } from '../report.js';
import { isScored } from '../scoring/score.js';
import { escapeControlChars } from '../text.js';

const CATEGORY_TITLES: Record<Category, string> = {
  availability: 'Availability',
  security: 'Security',
  seo: 'SEO',
  accessibility: 'Accessibility',
};

const SYMBOLS: Record<Status, string> = {
  pass: '✓',
  warn: '⚠',
  fail: '✗',
  error: '✗',
  skip: '–',
};
const COLORS: Record<Status, string> = {
  pass: '\x1b[32m',
  warn: '\x1b[33m',
  fail: '\x1b[31m',
  error: '\x1b[31m',
  skip: '\x1b[2m',
};
const RESET = '\x1b[0m';
const MAX_LISTED_URLS = 3;
const RULE = '─'.repeat(40);

/** Color only for a TTY, and never when NO_COLOR is set to a non-empty value (no-color.org). */
export function shouldUseColor(env: Record<string, string | undefined>, isTTY: boolean): boolean {
  return isTTY && !env['NO_COLOR'];
}

/** URLs of the pages where a check did not pass; empty unless several pages were analysed. */
function affectedUrls(report: Report, id: string): string[] {
  return (report.pages ?? [])
    .filter((p) =>
      p.checks.some((c) => c.id === id && (c.status === 'warn' || c.status === 'fail')),
    )
    .map((p) => p.url);
}

export function renderTerminal(report: Report, options: { color?: boolean } = {}): string {
  const paint = (status: Status, text: string) =>
    options.color ? `${COLORS[status]}${text}${RESET}` : text;

  const lines = ['SiteCheck', RULE, '', `URL: ${report.url}`];
  if (report.finalUrl !== report.url) lines.push(`Final URL: ${report.finalUrl}`);
  if (report.meta.truncated) {
    lines.push('Note: the page exceeded the size limit; only its beginning was analysed.');
  }

  if (report.pages) {
    const skipped = report.pages.filter((p) => p.skipped !== undefined);
    lines.push(
      `Pages analysed: ${report.meta.pagesAnalyzed}` +
        (skipped.length > 0 ? ` (${skipped.length} skipped)` : ''),
    );
    for (const p of skipped) {
      lines.push(`  – ${escapeControlChars(p.url)}: ${escapeControlChars(p.skipped ?? '')}`);
    }
  }

  for (const category of Object.keys(CATEGORY_TITLES) as Category[]) {
    const checks = report.checks.filter((c) => c.category === category);
    if (checks.length === 0) continue;
    const { score, max } = report.categories[category];
    const summary = checks.some(isScored) ? `${score}/${max}` : 'not checked';
    lines.push('', `${CATEGORY_TITLES[category]} (${summary})`);
    for (const check of checks) {
      // Messages may quote site data; escaping again guards against a check that forgot to.
      const wcag = check.wcag?.length ? ` (WCAG ${check.wcag.join(', ')})` : '';
      lines.push(
        `  ${paint(check.status, SYMBOLS[check.status])} ${escapeControlChars(check.message)}${wcag}`,
      );
      if (check.remediation && check.status !== 'pass') {
        lines.push(`    → ${escapeControlChars(check.remediation)}`);
      }
      if (check.status !== 'pass') {
        const urls = affectedUrls(report, check.id);
        for (const url of urls.slice(0, MAX_LISTED_URLS)) {
          lines.push(`    ${escapeControlChars(url)}`);
        }
        if (urls.length > MAX_LISTED_URLS) {
          lines.push(`    +${urls.length - MAX_LISTED_URLS} more`);
        }
      }
    }
  }
  lines.push('', RULE, `Score: ${report.score}/100 (${report.grade})`);
  return lines.join('\n') + '\n';
}
