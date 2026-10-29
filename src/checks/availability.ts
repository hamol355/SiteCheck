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
const REDIRECT_CHAIN: CheckDefinition = {
  id: 'redirect-chain',
  category: 'availability',
  maxPoints: 2,
};
const WWW_CONSISTENCY: CheckDefinition = {
  id: 'www-consistency',
  category: 'availability',
  maxPoints: 3,
};
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

export function checkRedirectChain(page: Pick<FetchedPage, 'redirects'>): CheckResult {
  const count = page.redirects.length;
  if (count <= 1) {
    return makeResult(
      REDIRECT_CHAIN,
      'pass',
      count === 0 ? 'No redirects to the final URL' : 'One redirect to the final URL',
    );
  }
  const remediation =
    'Redirect straight to the final URL (e.g. http://example.com directly to https://www.example.com/) instead of in several steps.';
  const message = `${count} redirects before the final URL`;
  return makeResult(REDIRECT_CHAIN, count <= 3 ? 'warn' : 'fail', message, remediation);
}

/**
 * The host to try for the www/non-www check, or null when it should be skipped. Only `www.x` and
 * two-label hosts qualify; without a public suffix list other hosts (`example.co.uk`) are not guessed.
 */
export function wwwCounterpart(finalUrl: string): string | null {
  const url = new URL(finalUrl);
  const host = url.hostname;
  if (/^[\d.]+$/.test(host) || host.includes(':')) return null;
  if (host.startsWith('www.')) {
    url.hostname = host.slice(4);
  } else if (host.split('.').length === 2) {
    url.hostname = `www.${host}`;
  } else {
    return null;
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.href;
}

/** `probe` is null when the check does not apply (see `wwwCounterpart`). */
export function checkWwwConsistency(probe: StatusProbe | null, finalUrl: string): CheckResult {
  if (probe === null) {
    return makeResult(
      WWW_CONSISTENCY,
      'skip',
      'Skipped www-consistency: no www variant to compare',
    );
  }
  const { status, location } = probe;
  const host = new URL(probe.url).hostname;
  if (status !== null && status >= 300 && status < 400 && location) {
    let target: URL | null = null;
    try {
      target = new URL(location, probe.url);
    } catch {
      // Treated as a redirect that does not lead to the site below.
    }
    if (target && target.hostname !== host) {
      return makeResult(WWW_CONSISTENCY, 'pass', `${host} redirects to ${target.hostname}`);
    }
  }
  if (status !== null && status >= 200 && status < 300) {
    return makeResult(
      WWW_CONSISTENCY,
      'warn',
      `${host} also serves the site without redirecting to ${new URL(finalUrl).hostname} (duplicate content)`,
      'Pick one of www and non-www and 301-redirect the other to it.',
    );
  }
  return makeResult(WWW_CONSISTENCY, 'pass', `${host} does not serve a second copy of the site`);
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
  www: StatusProbe | null = null,
): CheckResult[] {
  return [
    safeRun(HTTP_STATUS, () => checkHttpStatus(page)),
    safeRun(RESPONSE_TIME, () => checkResponseTime(page)),
    safeRun(HTTPS_REDIRECT, () => checkHttpsRedirect(probe)),
    safeRun(SOFT_404, () => checkSoft404(soft404)),
    safeRun(REDIRECT_CHAIN, () => checkRedirectChain(page)),
    safeRun(WWW_CONSISTENCY, () => checkWwwConsistency(www, page.finalUrl)),
  ];
}
