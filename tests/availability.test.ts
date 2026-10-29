import { describe, expect, it } from 'vitest';
import {
  checkHttpStatus,
  checkHttpsRedirect,
  checkRedirectChain,
  checkResponseTime,
  checkWwwConsistency,
  wwwCounterpart,
  checkSoft404,
  runAvailabilityChecks,
} from '../src/checks/availability.js';
import { makeResult, safeRun } from '../src/checks/run.js';
import type { FetchedPage, HttpRedirectProbe } from '../src/checks/types.js';

function page(overrides: Partial<FetchedPage> = {}): FetchedPage {
  return {
    requestedUrl: 'https://example.com/',
    finalUrl: 'https://example.com/',
    status: 200,
    headers: {},
    setCookies: [],
    html: '<html></html>',
    truncated: false,
    responseTimeMs: 100,
    redirects: [],
    ...overrides,
  };
}

describe('http-status', () => {
  it.each([200, 204, 299])('passes for %i', (status) => {
    const r = checkHttpStatus({ status });
    expect(r.status).toBe('pass');
    expect(r.points).toBe(8);
    expect(r.remediation).toBeUndefined();
  });

  it.each([300, 302, 304])('warns for an unfollowed %i', (status) => {
    const r = checkHttpStatus({ status });
    expect(r.status).toBe('warn');
    expect(r.points).toBe(4);
    expect(r.message).toBe(`Responded with HTTP ${status}, which could not be followed to a page`);
    expect(r.remediation).toBeDefined();
  });

  it.each([404, 500, 503])('fails for %i', (status) => {
    const r = checkHttpStatus({ status });
    expect(r.status).toBe('fail');
    expect(r.points).toBe(0);
    expect(r.remediation).toBeDefined();
  });
});

describe('response-time', () => {
  it.each([
    [0, 'pass'],
    [499, 'pass'],
    [500, 'warn'],
    [1499, 'warn'],
    [1500, 'fail'],
    [10000, 'fail'],
  ] as const)('%i ms is %s', (responseTimeMs, status) => {
    expect(checkResponseTime({ responseTimeMs }).status).toBe(status);
  });

  it('gives half points for warn', () => {
    expect(checkResponseTime({ responseTimeMs: 800 }).points).toBe(3);
  });
});

describe('soft-404', () => {
  const probe = (status: number | null) => ({
    url: 'https://example.com/x',
    status,
    location: null,
  });

  it.each([404, 410])('passes on %i', (status) => {
    expect(checkSoft404(probe(status)).status).toBe('pass');
  });

  it('fails on 200 with remediation', () => {
    const r = checkSoft404(probe(200));
    expect(r.status).toBe('fail');
    expect(r.remediation).toBeDefined();
  });

  it.each([301, 302, 403, 500])('warns on %i', (status) => {
    expect(checkSoft404(probe(status)).status).toBe('warn');
  });

  it('skips when the request failed or was disallowed by robots.txt', () => {
    expect(checkSoft404(probe(null)).status).toBe('skip');
    expect(checkSoft404(null).status).toBe('skip');
  });
});

describe('runAvailabilityChecks', () => {
  it('returns one result per check', () => {
    const results = runAvailabilityChecks(page(), {
      url: 'http://example.com/',
      status: 301,
      location: 'https://example.com/',
      redirects: [],
    });
    expect(results.map((r) => r.id)).toEqual([
      'http-status',
      'response-time',
      'https-redirect',
      'soft-404',
      'redirect-chain',
      'www-consistency',
    ]);
    expect(results.every((r) => r.category === 'availability')).toBe(true);
  });
});

describe('safeRun', () => {
  const def = { id: 'boom', category: 'seo', maxPoints: 4 } as const;

  it('turns a thrown error into an error result', () => {
    const r = safeRun(def, () => {
      throw new Error('kaboom');
    });
    expect(r).toMatchObject({ id: 'boom', status: 'error', points: 0, maxPoints: 4 });
    expect(r.message).toBe('Check failed to run: kaboom');
  });

  it('passes through a normal result', () => {
    expect(safeRun(def, () => makeResult(def, 'pass', 'ok')).status).toBe('pass');
  });
});

describe('https-redirect', () => {
  const url = 'http://example.com/';
  const probe = (
    status: number | null,
    location: string | null,
    redirects: HttpRedirectProbe['redirects'] = [],
  ): HttpRedirectProbe => ({ url, status, location, redirects });
  const toWww = [{ from: url, to: 'http://www.example.com/', status: 301 }];

  it.each([301, 302, 307, 308])('passes for a %i to https', (status) => {
    const r = checkHttpsRedirect(probe(status, 'https://example.com/'));
    expect(r.status).toBe('pass');
    expect(r.points).toBe(6);
  });

  it('treats a protocol-relative Location from http as staying on http', () => {
    expect(checkHttpsRedirect(probe(301, '//example.com/')).status).toBe('warn');
  });

  it('warns when the redirect stays on http', () => {
    const r = checkHttpsRedirect(probe(301, 'http://www.example.com/'));
    expect(r.status).toBe('warn');
    expect(r.remediation).toBeDefined();
  });

  it('passes when an http redirect chain ends on https', () => {
    const r = checkHttpsRedirect(probe(301, 'https://www.example.com/', toWww));
    expect(r.status).toBe('pass');
    expect(r.message).toBe('HTTP redirects to HTTPS (301 via http://www.example.com/)');
  });

  it('resolves a relative Location against the last URL in the chain', () => {
    const r = checkHttpsRedirect(probe(301, '/secure', toWww));
    expect(r.status).toBe('warn');
  });

  it('fails when the chain ends on http content and names the last URL', () => {
    const r = checkHttpsRedirect(probe(200, null, toWww));
    expect(r.status).toBe('fail');
    expect(r.message).toContain('http://www.example.com/');
  });

  it('warns when port 80 does not respond', () => {
    const r = checkHttpsRedirect(probe(null, null));
    expect(r.status).toBe('warn');
    expect(r.points).toBe(3);
  });

  it('fails when http serves content without redirecting', () => {
    const r = checkHttpsRedirect(probe(200, null));
    expect(r.status).toBe('fail');
    expect(r.points).toBe(0);
  });

  it('warns for other unexpected statuses', () => {
    expect(checkHttpsRedirect(probe(404, null)).status).toBe('warn');
  });
});

describe('redirect-chain', () => {
  const chain = (n: number) =>
    checkRedirectChain({
      redirects: Array.from({ length: n }, (_, i) => ({
        from: `https://example.com/${i}`,
        to: `https://example.com/${i + 1}`,
        status: 301,
      })),
    });

  it.each([
    [0, 'pass'],
    [1, 'pass'],
    [2, 'warn'],
    [3, 'warn'],
    [4, 'fail'],
    [5, 'fail'],
  ])('%i redirects -> %s', (n, status) => {
    expect(chain(n).status).toBe(status);
  });
});

describe('wwwCounterpart', () => {
  it.each([
    ['https://example.com/a?b=1', 'https://www.example.com/'],
    ['https://www.example.com/', 'https://example.com/'],
    ['https://example.com:8443/', 'https://www.example.com:8443/'],
    ['https://blog.example.com/', null],
    ['https://example.co.uk/', null],
    ['https://127.0.0.1/', null],
    ['http://localhost/', null],
    ['https://[::1]/', null],
  ])('%s -> %s', (url, expected) => {
    expect(wwwCounterpart(url)).toBe(expected);
  });
});

describe('www-consistency', () => {
  const final = 'https://example.com/';
  const probe = (status: number | null, location: string | null = null) => ({
    url: 'https://www.example.com/',
    status,
    location,
  });

  it('passes when the other variant redirects to the site', () => {
    expect(checkWwwConsistency(probe(301, 'https://example.com/'), final).status).toBe('pass');
  });
  it('warns when the other variant redirects to a host other than the site', () => {
    const r = checkWwwConsistency(probe(301, 'https://elsewhere.test/'), final);
    expect(r.status).toBe('warn');
    expect(r.message).toContain('elsewhere.test');
  });
  it('skips when the other variant redirects within its own host', () => {
    expect(checkWwwConsistency(probe(301, '/en/'), final).status).toBe('skip');
  });
  it('passes when the other variant does not respond or errors', () => {
    expect(checkWwwConsistency(probe(null), final).status).toBe('pass');
    expect(checkWwwConsistency(probe(404), final).status).toBe('pass');
  });
  it('warns when the other variant serves the site itself', () => {
    const r = checkWwwConsistency(probe(200), final);
    expect(r.status).toBe('warn');
    expect(r.remediation).toBeDefined();
  });
  it('skips when there is no variant to compare', () => {
    expect(checkWwwConsistency(null, final).status).toBe('skip');
  });
});
