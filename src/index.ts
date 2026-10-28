import { runAvailabilityChecks } from './checks/availability.js';
import { BlockedError, detectBlock, robotsNotice } from './checks/blocked.js';
import { resolveSitemapUrl, runSeoSiteChecks } from './checks/seo.js';
import { runSecurityChecks } from './checks/security.js';
import type { Category } from './checks/types.js';
import { fetchPage, fetchText, probeHttpRedirect } from './net/http.js';
import { analyzePage } from './pages.js';
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
export type { Report } from './report.js';
export type { Grade } from './scoring/score.js';

export interface AnalyzeOptions {
  /** Clock used for `meta.analyzedAt`; injectable for deterministic tests. */
  now?: () => Date;
  /** Receives diagnostics that do not change the report (e.g. a robots.txt server error). */
  onNotice?: (message: string) => void;
}

/** Fetches the page once and runs all checks. Throws on network errors. */
export async function analyze(url: string, options: AnalyzeOptions = {}): Promise<Report> {
  const now = options.now ?? (() => new Date());
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
  if (notice) options.onNotice?.(notice);
  const reason = detectBlock(page, robots);
  if (reason) throw new BlockedError(reason, page.status, page.finalUrl);
  const sitemap = await fetchText(resolveSitemapUrl(page.finalUrl, robots));
  const pageChecks = analyzePage(page);
  const ofCategory = (category: Category) => pageChecks.filter((c) => c.category === category);
  const checks = [
    ...runAvailabilityChecks(page, probe),
    ...runSecurityChecks(page),
    ...ofCategory('seo'),
    ...runSeoSiteChecks({ robots, sitemap }),
    ...ofCategory('accessibility'),
  ];
  return {
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
    },
  };
}
