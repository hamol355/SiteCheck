import * as cheerio from 'cheerio';
import { runAccessibilityChecks } from './checks/accessibility.js';
import { BLOCK_MESSAGES, detectBlock } from './checks/blocked.js';
import { runSeoPageChecks } from './checks/seo.js';
import type { CheckResult, FetchedPage, TextResponse } from './checks/types.js';
import { fetchPage } from './net/http.js';

/** Extra pages are fetched at most this many at a time. */
export const PAGE_CONCURRENCY = 4;

export interface PageResult {
  /** The URL as requested (from the sitemap). */
  url: string;
  /** Final HTTP status, or null if the page could not be fetched. */
  status: number | null;
  /** Why the page was not analysed. Its `checks` are then empty and it does not affect scoring. */
  skipped?: string;
  checks: CheckResult[];
}

/** Parses the page once. A parse failure must not abort the run; the page checks report it instead. */
function parse(html: string | null): cheerio.CheerioAPI | null {
  if (html === null) return null;
  try {
    return cheerio.load(html);
  } catch {
    return null;
  }
}

/**
 * Runs the checks that apply to every analysed page: the page checks in `seo`, then
 * `accessibility`. Pure: no network.
 */
export function analyzePage(page: Pick<FetchedPage, 'html' | 'status'>): CheckResult[] {
  const input = { $: parse(page.html), status: page.status };
  return [...runSeoPageChecks(input), ...runAccessibilityChecks(input)];
}

/** Fetches one extra page and analyses it, or says why it was skipped. Never throws. */
export async function fetchAndAnalyzePage(url: string, robots: TextResponse): Promise<PageResult> {
  let page: FetchedPage;
  try {
    page = await fetchPage(url, { sameOrigin: true });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { url, status: null, skipped: reason, checks: [] };
  }
  const skip = (skipped: string): PageResult => ({ url, status: page.status, skipped, checks: [] });
  const block = detectBlock(page, robots);
  if (block) return skip(`Access not allowed: ${BLOCK_MESSAGES[block]}`);
  if (page.status < 200 || page.status >= 300) return skip(`Responded with HTTP ${page.status}`);
  if (page.html === null) return skip('Not an HTML page');
  return { url, status: page.status, checks: analyzePage(page) };
}

/** Runs `fn` over `items` with at most `limit` in flight. Results keep the order of `items`. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Fetches and analyses extra pages (not the start page), at most PAGE_CONCURRENCY at a time.
 * Failed, blocked and non-HTML pages are skipped with a reason instead of aborting the run.
 */
export function analyzeExtraPages(urls: string[], robots: TextResponse): Promise<PageResult[]> {
  return mapLimit(urls, PAGE_CONCURRENCY, (url) => fetchAndAnalyzePage(url, robots));
}
