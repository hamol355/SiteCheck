import { describe, expect, it } from 'vitest';
import { detectBlock, isDisallowedByRobots, robotsNotice } from '../src/checks/blocked.js';
import type { FetchedPage, TextResponse } from '../src/checks/types.js';

const page = (overrides: Partial<FetchedPage> = {}): FetchedPage => ({
  requestedUrl: 'https://example.com/',
  finalUrl: 'https://example.com/',
  status: 200,
  headers: {},
  setCookies: [],
  html: '<html><body>Hello</body></html>',
  truncated: false,
  responseTimeMs: 10,
  redirects: [],
  ...overrides,
});

const robots = (body: string, status: number | null = 200): TextResponse => ({
  url: 'https://example.com/robots.txt',
  status,
  contentType: 'text/plain',
  body,
});

const NO_ROBOTS = robots('', 404);

describe('detectBlock by status', () => {
  it('returns null for a normal page', () => {
    expect(detectBlock(page(), NO_ROBOTS)).toBeNull();
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [429, 'rate-limited'],
  ])('maps HTTP %i to %s', (status, reason) => {
    expect(detectBlock(page({ status, html: '<p>no</p>' }), NO_ROBOTS)).toBe(reason);
  });

  it.each([404, 410, 500, 502, 503])('does not treat HTTP %i as a block', (status) => {
    expect(detectBlock(page({ status, html: '<p>oops</p>' }), NO_ROBOTS)).toBeNull();
  });
});

describe('detectBlock challenges', () => {
  it('detects cf-mitigated: challenge on any status', () => {
    const p = page({ status: 200, headers: { 'cf-mitigated': 'challenge' } });
    expect(detectBlock(p, NO_ROBOTS)).toBe('challenge');
  });

  it.each([
    ['Cloudflare', '<html><head><title>Just a moment...</title></head></html>'],
    ['Cloudflare script', '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate"></script>'],
    ['DataDome', '<iframe src="https://geo.captcha-delivery.com/captcha/"></iframe>'],
    ['PerimeterX', '<div id="px-captcha"></div>'],
    ['captcha widget', '<div class="g-recaptcha"></div>'],
  ])('detects a %s challenge page on 403', (_name, html) => {
    expect(detectBlock(page({ status: 403, html }), NO_ROBOTS)).toBe('challenge');
  });

  it('detects a challenge served with 503', () => {
    const html = '<title>Just a moment...</title>';
    expect(detectBlock(page({ status: 503, html }), NO_ROBOTS)).toBe('challenge');
  });

  it('detects DataDome by header', () => {
    const p = page({ status: 403, headers: { 'x-datadome': 'protected' }, html: '' });
    expect(detectBlock(p, NO_ROBOTS)).toBe('challenge');
  });

  it('prefers challenge over a plain 403', () => {
    const p = page({ status: 403, html: '<title>Just a moment...</title>' });
    expect(detectBlock(p, NO_ROBOTS)).toBe('challenge');
  });

  it('ignores challenge-like text on a 200 page', () => {
    const p = page({ html: '<title>Just a moment...</title><div class="g-recaptcha"></div>' });
    expect(detectBlock(p, NO_ROBOTS)).toBeNull();
  });

  it('handles a non-HTML 403 body', () => {
    expect(detectBlock(page({ status: 403, html: null }), NO_ROBOTS)).toBe('forbidden');
  });
});

describe('robots.txt', () => {
  const url = 'https://example.com/';

  it('blocks when * disallows everything', () => {
    expect(detectBlock(page(), robots('User-agent: *\nDisallow: /'))).toBe('robots-disallow');
  });

  it('allows when the Disallow is empty', () => {
    expect(isDisallowedByRobots(robots('User-agent: *\nDisallow:'), url)).toBe(false);
  });

  it('prefers the SiteCheck group over *', () => {
    const txt = 'User-agent: *\nDisallow: /\n\nUser-agent: SiteCheck\nDisallow: /private';
    expect(isDisallowedByRobots(robots(txt), url)).toBe(false);
    expect(isDisallowedByRobots(robots(txt), 'https://example.com/private/a')).toBe(true);
  });

  it('blocks when SiteCheck is named and disallowed, even if * allows', () => {
    const txt = 'User-agent: sitecheck\nDisallow: /\n\nUser-agent: *\nDisallow:';
    expect(isDisallowedByRobots(robots(txt), url)).toBe(true);
  });

  it('uses the longest match and lets Allow win ties', () => {
    const txt = 'User-agent: *\nDisallow: /docs\nAllow: /docs/public';
    expect(isDisallowedByRobots(robots(txt), 'https://example.com/docs/x')).toBe(true);
    expect(isDisallowedByRobots(robots(txt), 'https://example.com/docs/public/x')).toBe(false);
    const tie = 'User-agent: *\nDisallow: /a\nAllow: /a';
    expect(isDisallowedByRobots(robots(tie), 'https://example.com/a')).toBe(false);
  });

  it('supports * and $ in patterns and matches the query', () => {
    const txt = 'User-agent: *\nDisallow: /*.pdf$\nDisallow: /search?';
    expect(isDisallowedByRobots(robots(txt), 'https://example.com/a/b.pdf')).toBe(true);
    expect(isDisallowedByRobots(robots(txt), 'https://example.com/a/b.pdf?x=1')).toBe(false);
    expect(isDisallowedByRobots(robots(txt), 'https://example.com/search?q=1')).toBe(true);
  });

  it('merges consecutive User-agent lines into one group and ignores comments', () => {
    const txt = '# hi\nUser-agent: Googlebot\nUser-agent: *  # everyone\nDisallow: /x # no';
    expect(isDisallowedByRobots(robots(txt), 'https://example.com/x')).toBe(true);
  });

  it.each([
    ['404', robots('User-agent: *\nDisallow: /', 404)],
    ['403', robots('User-agent: *\nDisallow: /', 403)],
    ['418', robots('User-agent: *\nDisallow: /', 418)],
    ['500', robots('User-agent: *\nDisallow: /', 500)],
    ['fetch failure', robots('', null)],
  ])('allows everything when robots.txt is %s', (_name, r) => {
    expect(isDisallowedByRobots(r, url)).toBe(false);
  });

  it('parses a robots.txt with a BOM and CR line endings', () => {
    expect(isDisallowedByRobots(robots('\uFEFFUser-agent: *\nDisallow: /'), url)).toBe(true);
    expect(isDisallowedByRobots(robots('User-agent: *\rDisallow: /'), url)).toBe(true);
  });

  it('compares paths percent-encoded', () => {
    const encoded = 'https://example.com/%C3%A5k?q=%C3%A5';
    expect(isDisallowedByRobots(robots('User-agent: *\nDisallow: /åk'), encoded)).toBe(true);
    expect(isDisallowedByRobots(robots('User-agent: *\nDisallow: /%c3%a5k'), encoded)).toBe(true);
    const unencoded = 'https://example.com/åk';
    expect(isDisallowedByRobots(robots('User-agent: *\nDisallow: /åk'), unencoded)).toBe(true);
  });

  it('ignores an HTML response served as robots.txt', () => {
    const r = { ...robots('User-agent: *\nDisallow: /'), contentType: 'text/html' };
    expect(isDisallowedByRobots(r, url)).toBe(false);
  });

  it('checks the final URL, not the requested one', () => {
    const p = page({ requestedUrl: 'https://example.com/', finalUrl: 'https://example.com/app' });
    expect(detectBlock(p, robots('User-agent: *\nDisallow: /app'))).toBe('robots-disallow');
  });

  it('reports a status block before robots-disallow', () => {
    const p = page({ status: 403, html: '' });
    expect(detectBlock(p, robots('User-agent: *\nDisallow: /'))).toBe('forbidden');
  });
});

describe('robotsNotice', () => {
  it.each([500, 503])('returns a notice for HTTP %i', (status) => {
    expect(robotsNotice(robots('', status))).toBe(
      `robots.txt responded with HTTP ${status}; treating it as allowing everything.`,
    );
  });

  it.each([200, 404, 418, null])('returns null for %s', (status) => {
    expect(robotsNotice(robots('', status))).toBeNull();
  });
});
