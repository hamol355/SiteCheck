import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checkCsp,
  checkContentTypeOptions,
  checkHsts,
  checkHttps,
  checkPermissionsPolicy,
  checkReferrerPolicy,
  HSTS_MIN_MAX_AGE_SECONDS,
  parseCsp,
  parseCspPolicies,
  parseHsts,
  runSecurityChecks,
} from '../src/checks/security.js';

const HTTPS_URL = 'https://example.com/';
const goodHeaders = JSON.parse(
  readFileSync(new URL('./fixtures/headers-good.json', import.meta.url), 'utf8'),
) as Record<string, string>;

describe('parseHsts', () => {
  it('parses all directives, case-insensitively', () => {
    expect(parseHsts('Max-Age=31536000; includeSubDomains; PRELOAD')).toEqual({
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    });
  });

  it('accepts a quoted max-age', () => {
    expect(parseHsts('max-age="100"').maxAge).toBe(100);
  });

  it.each(['', 'includeSubDomains', 'max-age=', 'max-age=abc', 'max-age=-5', 'max-age=1.5'])(
    'returns null max-age for "%s"',
    (value) => {
      expect(parseHsts(value).maxAge).toBeNull();
    },
  );

  it('uses the first max-age when duplicated', () => {
    expect(parseHsts('max-age=10; max-age=20').maxAge).toBe(10);
  });

  it('uses only the first of several joined headers', () => {
    expect(parseHsts('max-age=31536000, max-age=60; preload')).toEqual({
      maxAge: 31536000,
      includeSubDomains: false,
      preload: false,
    });
  });
});

describe('parseCsp', () => {
  it('parses directives and sources', () => {
    const csp = parseCsp("default-src 'self'; script-src 'self' https://cdn.example.com;");
    expect(csp.get('default-src')).toEqual(["'self'"]);
    expect(csp.get('script-src')).toEqual(["'self'", 'https://cdn.example.com']);
  });

  it('lowercases directive names and keeps the first duplicate', () => {
    const csp = parseCsp("Script-Src 'self'; script-src 'none'");
    expect(csp.get('script-src')).toEqual(["'self'"]);
  });

  it('handles directives without sources and empty input', () => {
    expect(parseCsp('upgrade-insecure-requests').get('upgrade-insecure-requests')).toEqual([]);
    expect(parseCsp('').size).toBe(0);
  });
});

describe('parseCspPolicies', () => {
  it('splits joined headers into separate policies', () => {
    const policies = parseCspPolicies("default-src 'self', style-src 'unsafe-inline'");
    expect(policies).toHaveLength(2);
    expect(policies[0]?.get('default-src')).toEqual(["'self'"]);
    expect(policies[1]?.get('style-src')).toEqual(["'unsafe-inline'"]);
  });

  it('drops empty policies', () => {
    expect(parseCspPolicies("default-src 'self', ")).toHaveLength(1);
  });
});

describe('https', () => {
  it('passes for https and fails for http', () => {
    expect(checkHttps(HTTPS_URL).status).toBe('pass');
    const r = checkHttps('http://example.com/');
    expect(r.status).toBe('fail');
    expect(r.remediation).toBeDefined();
  });
});

describe('strict-transport-security', () => {
  const sixMonths = HSTS_MIN_MAX_AGE_SECONDS;

  it('passes at exactly six months', () => {
    expect(
      checkHsts({ 'strict-transport-security': `max-age=${sixMonths}` }, HTTPS_URL).status,
    ).toBe('pass');
  });

  it('warns below six months', () => {
    const r = checkHsts({ 'strict-transport-security': `max-age=${sixMonths - 1}` }, HTTPS_URL);
    expect(r.status).toBe('warn');
    expect(r.points).toBe(4);
    expect(r.remediation).toContain('Strict-Transport-Security');
  });

  it.each(['max-age=0', 'includeSubDomains', 'nonsense', '   '])('fails for "%s"', (value) => {
    expect(checkHsts({ 'strict-transport-security': value }, HTTPS_URL).status).toBe('fail');
  });

  it('fails when missing', () => {
    expect(checkHsts({}, HTTPS_URL).status).toBe('fail');
  });

  it('fails over http even with a valid header', () => {
    const r = checkHsts(
      { 'strict-transport-security': `max-age=${sixMonths}` },
      'http://example.com/',
    );
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/HTTP/);
  });
});

describe('content-security-policy', () => {
  it('passes for a strict policy', () => {
    expect(checkCsp({ 'content-security-policy': "default-src 'self'" }).status).toBe('pass');
  });

  it('fails when missing or blank', () => {
    expect(checkCsp({}).status).toBe('fail');
    expect(checkCsp({ 'content-security-policy': ' ' }).status).toBe('fail');
  });

  it("warns on 'unsafe-inline' in default-src", () => {
    const r = checkCsp({ 'content-security-policy': "default-src 'self' 'unsafe-inline'" });
    expect(r.status).toBe('warn');
    expect(r.message).toContain('default-src');
  });

  it("warns on 'unsafe-eval' in script-src, case-insensitively", () => {
    const r = checkCsp({ 'content-security-policy': "SCRIPT-SRC 'self' 'UNSAFE-EVAL'" });
    expect(r.status).toBe('warn');
    expect(r.message).toContain("'unsafe-eval'");
  });

  it('reports both unsafe keywords', () => {
    const r = checkCsp({
      'content-security-policy': "script-src 'unsafe-inline' 'unsafe-eval'",
    });
    expect(r.message).toContain("'unsafe-inline' and 'unsafe-eval'");
  });

  it('lets script-src override an unsafe default-src', () => {
    const r = checkCsp({
      'content-security-policy': "default-src 'unsafe-inline'; script-src 'self'",
    });
    expect(r.status).toBe('pass');
  });

  it('ignores unsafe keywords in unrelated directives', () => {
    const r = checkCsp({
      'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'",
    });
    expect(r.status).toBe('pass');
  });

  it.each(["'nonce-abc123'", "'sha256-abc='", "'SHA384-abc='"])(
    "ignores 'unsafe-inline' next to %s",
    (source) => {
      const r = checkCsp({
        'content-security-policy': `script-src ${source} 'strict-dynamic' 'unsafe-inline'`,
      });
      expect(r.status).toBe('pass');
    },
  );

  it("still warns on 'unsafe-eval' next to a nonce", () => {
    const r = checkCsp({
      'content-security-policy': "script-src 'nonce-abc' 'unsafe-inline' 'unsafe-eval'",
    });
    expect(r.status).toBe('warn');
    expect(r.message).toContain("allows 'unsafe-eval' in");
    expect(r.message).not.toContain("'unsafe-inline'");
  });

  it('does not read a second joined policy as part of the first', () => {
    const r = checkCsp({
      'content-security-policy': "default-src 'self', style-src 'unsafe-inline'",
    });
    expect(r.status).toBe('pass');
  });

  it.each(["frame-ancestors 'none'", 'upgrade-insecure-requests', "style-src 'self'"])(
    'warns when "%s" does not restrict scripts',
    (value) => {
      const r = checkCsp({ 'content-security-policy': value });
      expect(r.status).toBe('warn');
      expect(r.message).toContain('does not restrict scripts');
      expect(r.remediation).toBeDefined();
    },
  );

  it('passes when a stricter policy blocks what another allows', () => {
    const r = checkCsp({
      'content-security-policy': "script-src 'unsafe-inline', script-src 'self'",
    });
    expect(r.status).toBe('pass');
  });

  it('warns when every joined policy allows the keyword', () => {
    const r = checkCsp({
      'content-security-policy': "script-src 'unsafe-inline', default-src 'self' 'unsafe-inline'",
    });
    expect(r.status).toBe('warn');
  });
});

describe('x-content-type-options', () => {
  it.each(['nosniff', 'NoSniff', ' nosniff ', 'nosniff, nosniff'])('passes for "%s"', (value) => {
    expect(checkContentTypeOptions({ 'x-content-type-options': value }).status).toBe('pass');
  });

  it('fails when missing', () => {
    const r = checkContentTypeOptions({});
    expect(r.status).toBe('fail');
    expect(r.remediation).toBe('Add header: X-Content-Type-Options: nosniff');
  });

  it('fails for another value', () => {
    const r = checkContentTypeOptions({ 'x-content-type-options': 'sniff' });
    expect(r.status).toBe('fail');
    expect(r.message).toContain('sniff');
  });
});

describe('referrer-policy', () => {
  it.each([
    'no-referrer',
    'strict-origin-when-cross-origin',
    'Same-Origin',
    'origin, unsafe-url, no-referrer',
  ])('passes for "%s"', (value) => {
    expect(checkReferrerPolicy({ 'referrer-policy': value }).status).toBe('pass');
  });

  it.each([
    'unsafe-url',
    'No-Referrer-When-Downgrade',
    'no-referrer, unsafe-url',
    'unsafe-url, made-up',
  ])('warns for "%s"', (value) => {
    expect(checkReferrerPolicy({ 'referrer-policy': value }).status).toBe('warn');
  });

  it('reports the last recognised token', () => {
    const r = checkReferrerPolicy({ 'referrer-policy': 'same-origin, made-up' });
    expect(r.message).toBe('Referrer-Policy is same-origin');
  });

  it('fails when no token is recognised', () => {
    const r = checkReferrerPolicy({ 'referrer-policy': 'made-up' });
    expect(r.status).toBe('fail');
    expect(r.remediation).toBeDefined();
  });

  it('fails when missing', () => {
    expect(checkReferrerPolicy({}).status).toBe('fail');
  });
});

describe('permissions-policy', () => {
  it('passes with Permissions-Policy', () => {
    expect(checkPermissionsPolicy({ 'permissions-policy': 'camera=()' }).status).toBe('pass');
  });

  it('warns with only Feature-Policy', () => {
    const r = checkPermissionsPolicy({ 'feature-policy': "camera 'none'" });
    expect(r.status).toBe('warn');
    expect(r.remediation).toContain('Permissions-Policy');
  });

  it('fails when neither is set', () => {
    expect(checkPermissionsPolicy({}).status).toBe('fail');
  });
});

describe('runSecurityChecks', () => {
  const NOW = new Date('2026-06-01T00:00:00.000Z');
  const good = () => ({
    headers: { ...goodHeaders, 'x-frame-options': 'DENY' },
    finalUrl: HTTPS_URL,
    setCookies: [] as string[],
    tls: {
      host: 'example.com',
      port: 443,
      error: null,
      authorized: true,
      authorizationError: null,
      protocol: 'TLSv1.3',
      validTo: '2026-12-01T00:00:00.000Z',
    },
    now: NOW,
  });

  it('passes everything with good headers over https', () => {
    const results = runSecurityChecks(good());
    expect(results.map((r) => r.id)).toEqual([
      'https',
      'strict-transport-security',
      'content-security-policy',
      'x-content-type-options',
      'referrer-policy',
      'permissions-policy',
      'tls-certificate',
      'clickjacking',
      'cookie-flags',
    ]);
    expect(results.filter((r) => r.status !== 'pass').map((r) => r.id)).toEqual([]);
    expect(results.reduce((sum, r) => sum + r.maxPoints, 0)).toBe(57);
  });

  it('gives failures for no headers over http, except where the check does not apply', () => {
    const results = runSecurityChecks({
      headers: {},
      finalUrl: 'http://example.com/',
      setCookies: [],
      tls: null,
    });
    const ids = (status: string) => results.filter((r) => r.status === status).map((r) => r.id);
    expect(ids('skip')).toEqual(['tls-certificate']);
    expect(ids('pass')).toEqual(['cookie-flags']);
    expect(ids('fail')).toHaveLength(results.length - 2);
    expect(results.filter((r) => r.status === 'fail').every((r) => r.remediation)).toBe(true);
  });

  it('reports an error result instead of throwing for a bad URL', () => {
    const results = runSecurityChecks({ ...good(), finalUrl: 'not a url' });
    expect(results.find((r) => r.id === 'https')?.status).toBe('error');
    expect(results.find((r) => r.id === 'tls-certificate')?.status).toBe('error');
    expect(results.find((r) => r.id === 'content-security-policy')?.status).toBe('pass');
  });
});
