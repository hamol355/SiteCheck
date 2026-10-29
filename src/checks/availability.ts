import { makeResult, safeRun } from './run.js';
import type {
  CheckDefinition,
  CheckResult,
  FetchedPage,
  HttpRedirectProbe,
  StatusProbe,
} from './types.js';

export const RESPONSE_TIME_GOOD_MS = 500;
export const RESPONSE_TIME_SLOW_MS = 1500;

const HTTP_STATUS: CheckDefinition = { id: 'http-status', category: 'availability', maxPoints: 8 };
const RESPONSE_TIME: CheckDefinition = {
  id: 'response-time',
  category: 'availability',
  maxPoints: 6,
};
const SOFT_404: CheckDefinition = { id: 'soft-404', category: 'availability', maxPoints: 4 };
const HTTPS_REDIRECT: CheckDefinition = {
  id: 'https-redirect',
  category: 'availability',
  maxPoints: 6,
};

export function checkHttpStatus(page: Pick<FetchedPage, 'status'>): CheckResult {
  const { status } = page;
  if (status >= 200 && status < 300) {
    return makeResult(HTTP_STATUS, 'pass', `Responded with HTTP ${status}`);
  }
  // Redirects with a Location are followed before this check, so a 3xx here is a redirect
  // without one, or a status that is not followed (300, 304, ...).
  if (status >= 300 && status < 400) {
    return makeResult(
      HTTP_STATUS,
      'warn',
      `Responded with HTTP ${status}, which could not be followed to a page`,
      'Serve the page directly, or redirect with 301/308 and a Location header.',
    );
  }
  // 401/403/429 on the start page never get here: analyze() reports them as blocked.
  const remediation =
    status >= 500
      ? 'Check the server logs for the cause of the error.'
      : 'Make sure the URL is correct and the page exists.';
  return makeResult(HTTP_STATUS, 'fail', `Responded with HTTP ${status}`, remediation);
}

export function checkResponseTime(page: Pick<FetchedPage, 'responseTimeMs'>): CheckResult {
  const ms = page.responseTimeMs;
  const message = `Response time ${ms} ms`;
  if (ms < RESPONSE_TIME_GOOD_MS) return makeResult(RESPONSE_TIME, 'pass', message);
  const remediation =
    'Reduce time to first byte: enable caching, use a CDN, or reduce work done before responding.';
  if (ms < RESPONSE_TIME_SLOW_MS) return makeResult(RESPONSE_TIME, 'warn', message, remediation);
  return makeResult(RESPONSE_TIME, 'fail', message, remediation);
}

const HTTPS_REDIRECT_STATUSES = new Set([301, 302, 307, 308]);

export function checkHttpsRedirect(probe: HttpRedirectProbe): CheckResult {
  const remediation =
    'Redirect all http:// requests to https:// with a 301 response (e.g. "return 301 https://$host$request_uri;" in nginx).';
  const { status, location } = probe;
  const lastUrl = probe.redirects.at(-1)?.to ?? probe.url;
  const via = probe.redirects.length > 0 ? ` via ${lastUrl}` : '';
  if (status === null) {
    return makeResult(
      HTTPS_REDIRECT,
      'warn',
      `${probe.url} did not respond, so the HTTP to HTTPS redirect could not be verified`,
      'Make sure port 80 answers and redirects to https://, so visitors typing http:// reach the site.',
    );
  }
  if (HTTPS_REDIRECT_STATUSES.has(status) && location) {
    let target: URL | null = null;
    try {
      target = new URL(location, lastUrl);
    } catch {
      // Invalid Location is handled below as a redirect that does not lead to https.
    }
    if (target?.protocol === 'https:') {
      return makeResult(HTTPS_REDIRECT, 'pass', `HTTP redirects to HTTPS (${status}${via})`);
    }
    return makeResult(
      HTTPS_REDIRECT,
      'warn',
      `${probe.url} redirects (${status}${via}), but not to an https:// URL`,
      remediation,
    );
  }
  if (status >= 200 && status < 300) {
    return makeResult(
      HTTPS_REDIRECT,
      'fail',
      `${lastUrl} is served over HTTP without redirecting to HTTPS`,
      remediation,
    );
  }
  return makeResult(
    HTTPS_REDIRECT,
    'warn',
    `${lastUrl} responded with HTTP ${status} instead of redirecting to HTTPS`,
    remediation,
  );
}

/** `probe` is null when the random path is disallowed by robots.txt and so was not requested. */
export function checkSoft404(probe: StatusProbe | null): CheckResult {
  if (probe === null) {
    return makeResult(SOFT_404, 'skip', 'Skipped soft-404: robots.txt disallows the probe path');
  }
  const { status } = probe;
  if (status === null) {
    return makeResult(SOFT_404, 'skip', 'Skipped soft-404: the probe request failed');
  }
  if (status === 404 || status === 410) {
    return makeResult(SOFT_404, 'pass', `Missing pages respond with HTTP ${status}`);
  }
  const remediation =
    'Return HTTP 404 (or 410) for URLs that do not exist, so search engines do not index error pages.';
  if (status >= 200 && status < 300) {
    return makeResult(
      SOFT_404,
      'fail',
      `A page that does not exist responds with HTTP ${status} (soft 404)`,
      remediation,
    );
  }
  if (status >= 300 && status < 400) {
    return makeResult(
      SOFT_404,
      'warn',
      `A page that does not exist redirects (HTTP ${status}) instead of returning 404`,
      remediation,
    );
  }
  return makeResult(
    SOFT_404,
    'warn',
    `A page that does not exist responds with HTTP ${status} instead of 404`,
    remediation,
  );
}

export function runAvailabilityChecks(
  page: FetchedPage,
  probe: HttpRedirectProbe,
  soft404: StatusProbe | null = null,
): CheckResult[] {
  return [
    safeRun(HTTP_STATUS, () => checkHttpStatus(page)),
    safeRun(RESPONSE_TIME, () => checkResponseTime(page)),
    safeRun(HTTPS_REDIRECT, () => checkHttpsRedirect(probe)),
    safeRun(SOFT_404, () => checkSoft404(soft404)),
  ];
}
