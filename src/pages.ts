import * as cheerio from 'cheerio';
import { runAccessibilityChecks } from './checks/accessibility.js';
import { BLOCK_MESSAGES, detectBlock } from './checks/blocked.js';
import { pageDescription, pageTitle, runSeoPageChecks } from './checks/seo.js';
import { runSecurityPageChecks } from './checks/security.js';
import type { CheckResult, FetchedPage, TextResponse } from './checks/types.js';
import { fetchPage, type BytesResponse } from './net/http.js';
import { filterPageUrls, readSitemap, samplePages } from './net/sitemap.js';
import type { PageReport } from './report.js';

/** Extra pages are fetched at most this many at a time. */
export const PAGE_CONCURRENCY = 4;
/** Hard cap on pages per run, including the start page. */
export const MAX_PAGES = 50;

export interface PageResult {
  /** The URL as requested (from the sitemap). */
  url: string;
  /** Final HTTP status, or null if the page could not be fetched. */
  status: number | null;
  /** Why the page was not analysed. Its `checks` are then empty and it does not affect scoring. */
  skipped?: string;
  checks: CheckResult[];
  /** Title and meta description (empty if none), for the checks that compare pages. */
  title?: string;
  description?: string;
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
 * `accessibility` and the HTML-based `security` checks. Pure: no network.
 */
export function analyzePage(
  page: Pick<FetchedPage, 'html' | 'status' | 'headers' | 'finalUrl'>,
): CheckResult[] {
  const input = { $: parse(page.html), status: page.status };
  return [
    ...runSeoPageChecks({ ...input, headers: page.headers, finalUrl: page.finalUrl }),
    ...runAccessibilityChecks(input),
    ...runSecurityPageChecks({ ...input, headers: page.headers, finalUrl: page.finalUrl }),
  ];
}

/** What the cross-page checks need from a page. Empty strings when the page has none. */
export function pageFacts(html: string | null): { title: string; description: string } {
  const $ = parse(html);
  return $
    ? { title: pageTitle($), description: pageDescription($) }
    : { title: '', description: '' };
}

export const DEAD_PAGE_REMEDIATION =
  'Fix the page or remove its URL from the sitemap; a sitemap should only list working pages.';

/**
 * A sitemap URL that answers 4xx/5xx is a real problem with the site, so unlike the start page
 * (where `http-status` covers it) every page check fails instead of being skipped.
 */
function deadPageChecks(status: number, url: string): CheckResult[] {
  return analyzePage({ html: null, status, headers: {}, finalUrl: url }).map((check) => ({
    ...check,
    status: 'fail',
    message: `Page responded with HTTP ${status}`,
    remediation: DEAD_PAGE_REMEDIATION,
    points: 0,
  }));
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
  if (page.status >= 400)
    return { url, status: page.status, checks: deadPageChecks(page.status, url) };
  if (page.status < 200 || page.status >= 300) return skip(`Responded with HTTP ${page.status}`);
  if (page.html === null) return skip('Not an HTML page');
  return { url, status: page.status, checks: analyzePage(page), ...pageFacts(page.html) };
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
 * Picks up to `count - 1` extra pages from the sitemap: same origin as the start page, allowed by
 * robots.txt, spread over the site's sections. Reasons for analysing fewer pages go to `notify`.
 */
export async function selectExtraPages(
  startUrl: string,
  robots: TextResponse,
  rootSitemap: BytesResponse,
  count: number,
  notify: (message: string) => void,
): Promise<string[]> {
  const found = await readSitemap(startUrl, robots, rootSitemap);
  found.notices.forEach(notify);
  const candidates = filterPageUrls(found.urls, startUrl, robots);
  // A missing or invalid sitemap already has a notice; this covers one with nothing usable.
  if (candidates.length === 0 && (found.urls.length > 0 || found.notices.length === 0)) {
    notify(`Sitemap has no URLs on ${new URL(startUrl).origin}; analysing the start page only`);
  }
  return samplePages(startUrl, candidates, count).slice(1);
}

/** The public per-page entry: only id, status and message per check; the rest is in `checks`. */
export function toPageReport(page: PageResult): PageReport {
  const entry: PageReport = {
    url: page.url,
    status: page.status,
    checks: page.checks.map(({ id, status, message }) => ({ id, status, message })),
  };
  if (page.skipped !== undefined) entry.skipped = page.skipped;
  return entry;
}

/**
 * Fetches and analyses extra pages (not the start page), at most PAGE_CONCURRENCY at a time.
 * Failed, blocked and non-HTML pages are skipped with a reason instead of aborting the run.
 */
export function analyzeExtraPages(urls: string[], robots: TextResponse): Promise<PageResult[]> {
  return mapLimit(urls, PAGE_CONCURRENCY, (url) => fetchAndAnalyzePage(url, robots));
}
