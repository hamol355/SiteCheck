import { randomBytes } from 'node:crypto';
import { runAvailabilityChecks, wwwCounterpart } from './checks/availability.js';
import { BlockedError, detectBlock, isDisallowedByRobots, robotsNotice } from './checks/blocked.js';
import { runSeoCrossPageChecks, runSeoSiteChecks } from './checks/seo.js';
import { runSecurityChecks } from './checks/security.js';
import type { Category } from './checks/types.js';
import { aggregatePages } from './aggregate.js';
import {
  bytesToText,
  fetchPage,
  fetchText,
  probeHttpRedirect,
  probeStatus,
  probeTls,
} from './net/http.js';
import { fetchRootSitemap } from './net/sitemap.js';
import {
  analyzeExtraPages,
  analyzePage,
  pageFacts,
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
  TlsProbe,
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
  const finalUrl = new URL(page.finalUrl);
  const [probe, robots, tls] = await Promise.all([
    probing,
    fetchText(new URL('/robots.txt', page.finalUrl).href),
    finalUrl.protocol === 'https:'
      ? probeTls(finalUrl.hostname, finalUrl.port ? Number(finalUrl.port) : 443)
      : null,
  ]);
  const notice = robotsNotice(robots);
  if (notice) notify(notice);
  const reason = detectBlock(page, robots);
  if (reason) throw new BlockedError(reason, page.status, page.finalUrl);
  // The soft-404 probe path respects robots.txt like any other request, so it needs robots.txt first.
  const soft404Url = new URL(`/sitecheck-404-${randomBytes(8).toString('hex')}`, page.finalUrl)
    .href;
  // Fetched once: it feeds both the sitemap-xml check and the page selection.
  const securityTxtUrl = new URL('/.well-known/security.txt', page.finalUrl).href;
  const wwwUrl = wwwCounterpart(page.finalUrl);
  const [rootSitemap, soft404, securityTxt, www] = await Promise.all([
    fetchRootSitemap(page.finalUrl, robots),
    isDisallowedByRobots(robots, soft404Url) ? null : probeStatus(soft404Url),
    isDisallowedByRobots(robots, securityTxtUrl) ? null : fetchText(securityTxtUrl),
    wwwUrl === null ? null : probeStatus(wwwUrl),
  ]);

  const startPage: PageResult = {
    url: page.finalUrl,
    status: page.status,
    checks: analyzePage(page),
    ...pageFacts(page.html),
  };
  const extraUrls =
    pageCount > 1
      ? await selectExtraPages(page.finalUrl, robots, rootSitemap, pageCount, notify)
      : [];
  const pages = [startPage, ...(await analyzeExtraPages(extraUrls, robots))];
  const pageChecks = aggregatePages(pages);
  const ofCategory = (category: Category) => pageChecks.filter((c) => c.category === category);
  const checks = [
    ...runAvailabilityChecks(page, probe, soft404, www),
    ...runSecurityChecks({ ...page, tls, securityTxt }),
    ...ofCategory('security'),
    ...ofCategory('seo'),
    ...runSeoCrossPageChecks(
      pages
        .filter((p) => p.skipped === undefined && p.title !== undefined)
        .map((p) => ({ title: p.title!, description: p.description ?? '' })),
    ),
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
