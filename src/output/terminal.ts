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
const RULE = '─'.repeat(40);

/** Color only for a TTY, and never when NO_COLOR is set to a non-empty value (no-color.org). */
export function shouldUseColor(env: Record<string, string | undefined>, isTTY: boolean): boolean {
  return isTTY && !env['NO_COLOR'];
}

export function renderTerminal(report: Report, options: { color?: boolean } = {}): string {
  const paint = (status: Status, text: string) =>
    options.color ? `${COLORS[status]}${text}${RESET}` : text;

  const lines = ['SiteCheck', RULE, '', `URL: ${report.url}`];
  if (report.finalUrl !== report.url) lines.push(`Final URL: ${report.finalUrl}`);
  if (report.meta.truncated) {
    lines.push('Note: the page exceeded the size limit; only its beginning was analysed.');
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
    }
  }
  lines.push('', RULE, `Score: ${report.score}/100 (${report.grade})`);
  return lines.join('\n') + '\n';
}
