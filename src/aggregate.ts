import type { CheckResult, Status } from './checks/types.js';
import type { PageResult } from './pages.js';

/** Statuses that say something about the page; `error` and `skip` do not and are left out. */
const COUNTED: ReadonlySet<Status> = new Set(['pass', 'warn', 'fail']);

/**
 * What a passing per-page check means, for the aggregated message. The pages' own pass messages
 * describe one page (e.g. "Canonical URL is …"), so they cannot stand for all of them.
 */
export const PASS_SUMMARIES: Readonly<Record<string, string>> = {
  title: 'Title length is within limits',
  'meta-description': 'Meta description length is within limits',
  h1: 'Exactly one <h1>',
  'canonical-url': 'Canonical URL is set',
  'viewport-meta': 'Viewport meta tag is set',
  'html-lang': 'Document language is set',
  'html-lang-valid': 'Document language tag is valid',
  indexable: 'Pages can be indexed',
  'image-alt': 'Images have alt attributes',
  'heading-structure': 'Heading levels are in order',
  'link-name': 'Links have accessible names',
  'button-name': 'Buttons have accessible names',
  'form-label': 'Form fields have labels',
  'iframe-title': 'Iframes have a title',
  landmarks: 'One main landmark',
  'aria-valid': 'ARIA usage is valid',
  'zoom-allowed': 'Zooming is allowed',
  tabindex: 'No positive tabindex values',
  'meta-refresh': 'No delayed meta refresh',
  'table-headers': 'Data tables have headers',
  autocomplete: 'Personal data fields have autocomplete',
  'media-autoplay': 'No autoplaying media with sound',
  'mixed-content': 'No resources are loaded over HTTP',
};

/** E.g. "Exactly one <h1> on all 6 pages"; unknown ids fall back to "Passes on all 6 pages". */
function passMessage(id: string, n: number): string {
  const summary = PASS_SUMMARIES[id];
  return summary === undefined ? `Passes on all ${n} pages` : `${summary} on all ${n} pages`;
}

/**
 * Merges one check's results from several pages into one result, so scoring and `checks` in the
 * report stay one entry per check id:
 * - points: mean of the counted pages' points, rounded down (points stay integers);
 * - status: `pass` if all pass, `fail` if more than half fail, otherwise `warn`. Status and points
 *   are independent: status summarises for the reader, points drive scoring.
 * Pages where the check was `error` or `skip` are not counted. If no page counts, the first
 * page's result is used as is. With one counted page its result is returned unchanged.
 */
export function aggregateCheck(results: CheckResult[]): CheckResult {
  const counted = results.filter((r) => COUNTED.has(r.status));
  if (counted.length === 0) return results[0]!;
  if (counted.length === 1) return counted[0]!;

  const n = counted.length;
  const failing = counted.filter((r) => r.status === 'fail');
  const affected = counted.filter((r) => r.status !== 'pass');
  const points = Math.floor(counted.reduce((sum, r) => sum + r.points, 0) / n);
  const base: CheckResult = { ...counted[0]! };
  delete base.remediation;

  if (affected.length === 0) {
    return { ...base, status: 'pass', message: passMessage(base.id, n), points };
  }
  const status: Status = failing.length > n / 2 ? 'fail' : 'warn';
  // Describe the worst case: the first failing page, otherwise the first warning one.
  const example = failing[0] ?? affected[0]!;
  const result: CheckResult = {
    ...base,
    status,
    message: `${affected.length} of ${n} pages: ${example.message}`,
    points,
  };
  if (example.remediation !== undefined) result.remediation = example.remediation;
  return result;
}

/**
 * One result per check id across the analysed pages, in the order the first analysed page lists
 * them. Skipped pages are ignored.
 */
export function aggregatePages(pages: PageResult[]): CheckResult[] {
  const byId = new Map<string, CheckResult[]>();
  for (const page of pages) {
    if (page.skipped !== undefined) continue;
    for (const check of page.checks) {
      const list = byId.get(check.id);
      if (list) list.push(check);
      else byId.set(check.id, [check]);
    }
  }
  return [...byId.values()].map(aggregateCheck);
}
