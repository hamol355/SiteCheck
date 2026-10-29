import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import {
  checkClickjacking,
  checkCookieFlags,
  checkMixedContent,
  checkTlsCertificate,
  runSecurityPageChecks,
} from '../src/checks/security.js';
import type { TlsProbe } from '../src/checks/types.js';

const HTTPS_URL = 'https://example.com/';
const NOW = new Date('2026-06-01T00:00:00.000Z');
const daysFromNow = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString();
const tls = (overrides: Partial<TlsProbe> = {}): TlsProbe => ({
  host: 'example.com',
  port: 443,
  error: null,
  authorized: true,
  authorizationError: null,
  protocol: 'TLSv1.3',
  validTo: daysFromNow(90),
  ...overrides,
});

describe('checkTlsCertificate', () => {
  it('passes a valid certificate with plenty of time left', () => {
    const r = checkTlsCertificate(tls(), HTTPS_URL, NOW);
    expect(r.status).toBe('pass');
    expect(r.message).toContain('90 more days');
  });

  it.each([
    [30, 'pass'],
    [29, 'warn'],
    [7, 'warn'],
    [6, 'fail'],
    [-3, 'fail'],
  ] as const)('with %i days left it is %s', (days, status) => {
    expect(checkTlsCertificate(tls({ validTo: daysFromNow(days) }), HTTPS_URL, NOW).status).toBe(
      status,
    );
  });

  it('says so when the certificate has expired', () => {
    const r = checkTlsCertificate(tls({ validTo: daysFromNow(-3) }), HTTPS_URL, NOW);
    expect(r.message).toBe('Certificate has expired');
    expect(r.remediation).toBeDefined();
  });

  it('fails an untrusted chain with the OpenSSL reason', () => {
    const r = checkTlsCertificate(
      tls({ authorized: false, authorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT' }),
      HTTPS_URL,
      NOW,
    );
    expect(r.status).toBe('fail');
    expect(r.message).toContain('DEPTH_ZERO_SELF_SIGNED_CERT');
  });

  it('explains a missing intermediate certificate', () => {
    const r = checkTlsCertificate(
      tls({ authorized: false, authorizationError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' }),
      HTTPS_URL,
      NOW,
    );
    expect(r.message).toContain('intermediate');
  });

  it.each(['TLSv1', 'TLSv1.1'])('fails %s', (protocol) => {
    expect(checkTlsCertificate(tls({ protocol }), HTTPS_URL, NOW).status).toBe('fail');
  });

  it('accepts TLS 1.2', () => {
    expect(checkTlsCertificate(tls({ protocol: 'TLSv1.2' }), HTTPS_URL, NOW).status).toBe('pass');
  });

  it('skips when the handshake failed, there is no probe, or the page is http', () => {
    expect(checkTlsCertificate(tls({ error: 'ECONNREFUSED' }), HTTPS_URL, NOW).status).toBe('skip');
    expect(checkTlsCertificate(null, HTTPS_URL, NOW).status).toBe('skip');
    expect(checkTlsCertificate(tls(), 'http://example.com/', NOW).status).toBe('skip');
  });
});

describe('checkClickjacking', () => {
  it.each([
    [{ 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" }],
    [{ 'content-security-policy': "frame-ancestors 'self' https://partner.example" }],
    [{ 'x-frame-options': 'DENY' }],
    [{ 'x-frame-options': 'sameorigin' }],
    // Every policy is enforced, so one restricting policy is enough.
    [{ 'content-security-policy': 'frame-ancestors *, frame-ancestors https://a.example' }],
  ])('passes %j', (headers) => {
    expect(checkClickjacking(headers).status).toBe('pass');
  });

  it('warns for frame-ancestors * and for ALLOW-FROM only', () => {
    expect(checkClickjacking({ 'content-security-policy': 'frame-ancestors *' }).status).toBe(
      'warn',
    );
    expect(checkClickjacking({ 'x-frame-options': 'ALLOW-FROM https://a.example' }).status).toBe(
      'warn',
    );
  });

  it('treats an empty frame-ancestors like none', () => {
    expect(checkClickjacking({ 'content-security-policy': 'frame-ancestors' }).status).toBe('pass');
    expect(
      checkClickjacking({ 'content-security-policy': "default-src 'self'; frame-ancestors ;" })
        .status,
    ).toBe('pass');
  });

  it('fails when nothing restricts framing', () => {
    expect(checkClickjacking({}).status).toBe('fail');
    expect(checkClickjacking({ 'content-security-policy': "default-src 'self'" }).status).toBe(
      'fail',
    );
  });

  it('ignores Report-Only policies', () => {
    expect(
      checkClickjacking({ 'content-security-policy-report-only': "frame-ancestors 'none'" }).status,
    ).toBe('fail');
  });

  it('lets a restricting CSP win over ALLOW-FROM', () => {
    expect(
      checkClickjacking({
        'content-security-policy': "frame-ancestors 'self'",
        'x-frame-options': 'ALLOW-FROM https://a.example',
      }).status,
    ).toBe('pass');
  });
});

describe('checkCookieFlags', () => {
  const full = 'id=1; Path=/; Secure; HttpOnly; SameSite=Lax';

  it('passes with no cookies and with fully flagged cookies', () => {
    expect(checkCookieFlags([], HTTPS_URL).status).toBe('pass');
    const r = checkCookieFlags([full, full.toUpperCase()], HTTPS_URL);
    expect(r.status).toBe('pass');
    expect(r.message).toBe('All 2 cookies have Secure, HttpOnly and SameSite');
  });

  it('is not confused by commas in Expires', () => {
    const cookie = 'id=1; Expires=Wed, 21 Oct 2037 07:28:00 GMT; Secure; HttpOnly; SameSite=Strict';
    expect(checkCookieFlags([cookie], HTTPS_URL).status).toBe('pass');
  });

  it('warns for a missing HttpOnly or SameSite and counts the cookies', () => {
    const r = checkCookieFlags(
      [full, 'a=1; Secure; SameSite=Lax', 'b=1; Secure; HttpOnly'],
      HTTPS_URL,
    );
    expect(r.status).toBe('warn');
    expect(r.message).toBe('1 of 3 cookies missing HttpOnly; 1 of 3 cookies missing SameSite');
    expect(r.remediation).toBeDefined();
  });

  it('fails for a missing Secure on https', () => {
    const r = checkCookieFlags([full, 'a=1; HttpOnly; SameSite=Lax'], HTTPS_URL);
    expect(r.status).toBe('fail');
    expect(r.message).toBe('1 of 2 cookies missing Secure');
  });

  it('does not require Secure on a plain http page', () => {
    expect(checkCookieFlags(['a=1; HttpOnly; SameSite=Lax'], 'http://example.com/').status).toBe(
      'pass',
    );
  });

  it('fails SameSite=None without Secure even over http', () => {
    const r = checkCookieFlags(['a=1; HttpOnly; SameSite=None'], 'http://example.com/');
    expect(r.status).toBe('fail');
    expect(r.message).toContain('SameSite=None without Secure');
  });
});

describe('checkMixedContent', () => {
  const check = (html: string, headers: Record<string, string> = {}, url = HTTPS_URL) =>
    checkMixedContent(cheerio.load(html), headers, url);

  it('passes a page with only https and relative resources', () => {
    const r = check(
      '<img src="/a.png"><script src="https://cdn.example/x.js"></script><a href="http://other.example">link</a>',
    );
    expect(r.status).toBe('pass');
  });

  it.each([
    '<script src="http://cdn.example/x.js"></script>',
    '<link rel="stylesheet" href="http://cdn.example/x.css">',
    '<iframe src="http://cdn.example/"></iframe>',
    '<object data="http://cdn.example/x.swf"></object>',
    '<embed src="http://cdn.example/x.swf">',
  ])('fails for active content: %s', (html) => {
    const r = check(html);
    expect(r.status).toBe('fail');
    expect(r.message).toContain('http://cdn.example/');
    expect(r.remediation).toBeDefined();
  });

  it.each([
    '<img src="http://cdn.example/a.png">',
    '<audio src="http://cdn.example/a.mp3"></audio>',
    '<video><source src="http://cdn.example/a.mp4"></video>',
    '<img src="/a.png" srcset="/a-2x.png 2x, http://cdn.example/a-3x.png 3x">',
    '<picture><source srcset="http://cdn.example/a.webp"><img src="/a.png"></picture>',
    '<video poster="http://cdn.example/p.jpg"></video>',
  ])('warns for passive content only: %s', (html) => {
    expect(check(html).status).toBe('warn');
  });

  it('fails when active content is mixed with passive content', () => {
    expect(
      check('<img src="http://a.example/a.png"><script src="http://a.example/x.js"></script>')
        .status,
    ).toBe('fail');
  });

  it('resolves protocol-relative and <base href> URLs', () => {
    expect(check('<img src="//cdn.example/a.png">').status).toBe('pass');
    const r = check('<base href="http://static.example/"><img src="a.png">');
    expect(r.status).toBe('warn');
    expect(r.message).toContain('http://static.example/a.png');
  });

  it('ignores an invalid <base href>', () => {
    expect(check('<base href="http://[bad"><img src="a.png">').status).toBe('pass');
  });

  it('passes when CSP upgrades insecure requests', () => {
    const r = check('<script src="http://cdn.example/x.js"></script>', {
      'content-security-policy': "default-src 'self'; upgrade-insecure-requests",
    });
    expect(r.status).toBe('pass');
  });

  it('passes when a <meta> CSP upgrades insecure requests', () => {
    const r = check(
      '<meta http-equiv="Content-Security-Policy" content="upgrade-insecure-requests"><script src="http://cdn.example/x.js"></script>',
    );
    expect(r.status).toBe('pass');
  });

  it('passes https srcset candidates', () => {
    expect(check('<img srcset="https://cdn.example/a.png 1x, /b.png 2x">').status).toBe('pass');
  });

  it('skips a plain http page', () => {
    expect(check('<img src="http://a.example/a.png">', {}, 'http://example.com/').status).toBe(
      'skip',
    );
  });
});

describe('runSecurityPageChecks', () => {
  const input = (html: string | null, status = 200) => ({
    $: html === null ? null : cheerio.load(html),
    status,
    headers: {},
    finalUrl: HTTPS_URL,
  });

  it('runs mixed-content for the page', () => {
    const results = runSecurityPageChecks(input('<img src="a.png">'));
    expect(results.map((r) => [r.id, r.status])).toEqual([['mixed-content', 'pass']]);
  });

  it('skips error pages and fails non-HTML responses', () => {
    expect(runSecurityPageChecks(input('<html></html>', 500))[0]?.status).toBe('skip');
    expect(runSecurityPageChecks(input(null))[0]?.status).toBe('fail');
  });
});
