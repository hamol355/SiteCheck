import type { CheckResult, Status } from './checks/types.js';
import type { PageResult } from './pages.js';

/** Statuses that say something about the page; `error` and `skip` do not and are left out. */
const COUNTED: ReadonlySet<Status> = new Set(['pass', 'warn', 'fail']);

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
    return { ...base, status: 'pass', message: `Passes on all ${n} pages`, points };
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
