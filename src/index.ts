import { runAvailabilityChecks } from './checks/availability.js';
import { BlockedError, detectBlock, robotsNotice } from './checks/blocked.js';
import { runSeoSiteChecks } from './checks/seo.js';
import { runSecurityChecks } from './checks/security.js';
import type { Category } from './checks/types.js';
import { aggregatePages } from './aggregate.js';
import { bytesToText, fetchPage, fetchText, probeHttpRedirect } from './net/http.js';
import { fetchRootSitemap } from './net/sitemap.js';
import {
  analyzeExtraPages,
  analyzePage,
  MAX_PAGES,
  selectExtraPages,
  toPageReport,
  type PageResult,
} from './pages.js';
import type { Report } from './report.js';
import { calculateScore } from './scoring/score.js';
import { VERSION } from './version.js';

export type {
  CheckResult,
  FetchedPage,
  HttpRedirectProbe,
  TextResponse,
  Category,
  Status,
} from './checks/types.js';
export { BlockedError } from './checks/blocked.js';
export type { BlockReason } from './checks/blocked.js';
export {
  CrossOriginRedirectError,
  NetworkError,
  TimeoutError,
  TooManyRedirectsError,
} from './net/http.js';
export type { PageReport, Report } from './report.js';
export { MAX_PAGES } from './pages.js';
export type { Grade } from './scoring/score.js';

export interface AnalyzeOptions {
  /** Clock used for `meta.analyzedAt`; injectable for deterministic tests. */
  now?: () => Date;
  /** Receives diagnostics that do not change the report (e.g. a robots.txt server error). */
  onNotice?: (message: string) => void;
  /** Pages to analyse including the start page, 1–MAX_PAGES (default 1). Extra pages come from the sitemap. */
  pages?: number;
}

/** Fetches the start page once, plus up to `pages - 1` sitemap pages, and runs all checks. Throws on network errors. */
export async function analyze(url: string, options: AnalyzeOptions = {}): Promise<Report> {
  const now = options.now ?? (() => new Date());
  const pageCount = options.pages ?? 1;
  if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > MAX_PAGES) {
    throw new RangeError(`pages must be an integer from 1 to ${MAX_PAGES}`);
  }
  const notify = (message: string) => options.onNotice?.(message);
  // The probe uses the host the user gave (what visitors type) and never throws, so it runs in
  // parallel. It is aborted if the page fetch fails so it cannot keep the process alive.
  const probeController = new AbortController();
  const probing = probeHttpRedirect(url, { signal: probeController.signal });
  let page;
  try {
    page = await fetchPage(url);
  } catch (err) {
    probeController.abort();
    throw err;
  }
  // robots.txt only needs the final URL, so it runs alongside the probe; the sitemap needs robots.txt.
  const [probe, robots] = await Promise.all([
    probing,
    fetchText(new URL('/robots.txt', page.finalUrl).href),
  ]);
  const notice = robotsNotice(robots);
  if (notice) notify(notice);
  const reason = detectBlock(page, robots);
  if (reason) throw new BlockedError(reason, page.status, page.finalUrl);
  // Fetched once: it feeds both the sitemap-xml check and the page selection.
  const rootSitemap = await fetchRootSitemap(page.finalUrl, robots);

  const startPage: PageResult = {
    url: page.finalUrl,
    status: page.status,
    checks: analyzePage(page),
  };
  const extraUrls =
    pageCount > 1
      ? await selectExtraPages(page.finalUrl, robots, rootSitemap, pageCount, notify)
      : [];
  const pages = [startPage, ...(await analyzeExtraPages(extraUrls, robots))];
  const pageChecks = aggregatePages(pages);
  const ofCategory = (category: Category) => pageChecks.filter((c) => c.category === category);
  const checks = [
    ...runAvailabilityChecks(page, probe),
    ...runSecurityChecks(page),
    ...ofCategory('seo'),
    ...runSeoSiteChecks({ robots, sitemap: bytesToText(rootSitemap) }),
    ...ofCategory('accessibility'),
  ];
  const report: Report = {
    schemaVersion: 1,
    url,
    finalUrl: page.finalUrl,
    ...calculateScore(checks),
    checks,
    meta: {
      sitecheckVersion: VERSION,
      analyzedAt: now().toISOString(),
      responseTimeMs: page.responseTimeMs,
      truncated: page.truncated,
      pagesAnalyzed: pages.filter((p) => p.skipped === undefined).length,
    },
  };
  if (pageCount > 1) report.pages = pages.map(toPageReport);
  return report;
}
