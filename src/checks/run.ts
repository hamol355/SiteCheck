import type { CheerioAPI } from 'cheerio';
import { quoteUntrusted } from '../text.js';
import type { CheckDefinition, CheckResult, Status } from './types.js';

export const NOT_HTML_MESSAGE = 'Response is not HTML';

function pointsFor(status: Status, maxPoints: number): number {
  if (status === 'pass') return maxPoints;
  if (status === 'warn') return Math.floor(maxPoints / 2);
  return 0;
}

export function makeResult(
  def: CheckDefinition,
  status: Status,
  message: string,
  remediation?: string,
): CheckResult {
  const result: CheckResult = {
    id: def.id,
    category: def.category,
    status,
    message,
    points: pointsFor(status, def.maxPoints),
    maxPoints: def.maxPoints,
  };
  if (remediation !== undefined) result.remediation = remediation;
  if (def.wcag !== undefined) result.wcag = def.wcag;
  return result;
}

/** Runs a check and converts any thrown error into an `error` result. */
export function safeRun(def: CheckDefinition, fn: () => CheckResult): CheckResult {
  try {
    return fn();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return makeResult(def, 'error', `Check failed to run: ${quoteUntrusted(reason)}`);
  }
}

/** What checks of the page content get: the parsed page and the status it was served with. */
export interface PageInput {
  /** Parsed page, or null if the response was not HTML. */
  $: CheerioAPI | null;
  /** HTTP status of the final response. */
  status: number;
}

/**
 * Like `safeRun` for checks that need the parsed page. They are skipped when the page was not
 * served with 2xx (an error or block page says nothing about the real page) and fail when the
 * response was not HTML.
 */
export function safeRunPage(
  def: CheckDefinition,
  page: PageInput,
  fn: ($: CheerioAPI) => CheckResult,
): CheckResult {
  return safeRun(def, () => {
    if (page.status < 200 || page.status >= 300) {
      return makeResult(def, 'skip', `Skipped ${def.id}: page responded with HTTP ${page.status}`);
    }
    return page.$ ? fn(page.$) : makeResult(def, 'fail', NOT_HTML_MESSAGE);
  });
}
