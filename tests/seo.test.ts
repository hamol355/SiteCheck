import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import {
  checkCanonical,
  checkH1,
  checkMetaDescription,
  checkRobotsTxt,
  checkSitemap,
  checkTitle,
  extractSitemapUrls,
  resolveSitemapUrl,
  runSeoChecks,
} from '../src/checks/seo.js';
import type { TextResponse } from '../src/checks/types.js';

const load = (html: string) => cheerio.load(html);
const fixture = (name: string) =>
  load(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

function text(overrides: Partial<TextResponse> = {}): TextResponse {
  return {
    url: 'https://example.com/x',
    status: 200,
    contentType: 'text/plain',
    body: '',
    ...overrides,
  };
}

describe('title', () => {
  it.each([
    ['<title>Exactly ten</title>', 'pass'],
    ['<title>' + 'x'.repeat(60) + '</title>', 'pass'],
    ['<title>YouTube</title>', 'pass'],
    ['<title>' + 'x'.repeat(61) + '</title>', 'warn'],
    ['<title>   </title>', 'fail'],
    ['', 'fail'],
  ])('%s -> %s', (head, status) => {
    expect(checkTitle(load(`<html><head>${head}</head></html>`)).status).toBe(status);
  });

  it('trims whitespace before measuring', () => {
    expect(checkTitle(load('<title>  Exactly ten  </title>')).status).toBe('pass');
  });

  it('collapses line breaks and indentation before measuring', () => {
    const r = checkTitle(load('<title>\n    Short\n        title\n  </title>'));
    expect(r.message).toBe('Title is 11 characters');
  });

  it('ignores <title> inside inline SVG', () => {
    const r = checkTitle(load('<body><svg><title>An icon title here</title></svg></body>'));
    expect(r.status).toBe('fail');
  });

  it('uses the page title even when an SVG title comes first', () => {
    const r = checkTitle(
      load('<body><svg><title>Icon</title></svg><title>Exactly ten</title></body>'),
    );
    expect(r.message).toBe('Title is 11 characters');
  });
});

describe('meta-description', () => {
  const meta = (content: string) => load(`<meta name="Description" content="${content}">`);

  it('passes at 50 and 160 characters', () => {
    expect(checkMetaDescription(meta('x'.repeat(50))).status).toBe('pass');
    expect(checkMetaDescription(meta('x'.repeat(160))).status).toBe('pass');
  });

  it('warns outside the range', () => {
    expect(checkMetaDescription(meta('x'.repeat(49))).status).toBe('warn');
    expect(checkMetaDescription(meta('x'.repeat(161))).status).toBe('warn');
  });

  it('fails when missing or empty', () => {
    expect(checkMetaDescription(load('<html></html>')).status).toBe('fail');
    expect(checkMetaDescription(meta('')).status).toBe('fail');
  });

  it('collapses whitespace runs before measuring', () => {
    const words = Array.from({ length: 30 }, () => 'word').join('\n        ');
    expect(checkMetaDescription(meta(words)).message).toBe('Meta description is 149 characters');
  });
});

describe('h1', () => {
  it('passes for one, warns for several, fails for none', () => {
    expect(checkH1(load('<h1>a</h1>')).status).toBe('pass');
    expect(checkH1(load('<h1>a</h1><h1>b</h1>')).status).toBe('warn');
    expect(checkH1(load('<h2>a</h2>')).status).toBe('fail');
  });
});

describe('canonical-url', () => {
  const link = (href: string) => load(`<link rel="canonical" href="${href}">`);

  it('passes for an absolute URL', () => {
    expect(checkCanonical(link('https://example.com/a')).status).toBe('pass');
  });

  it.each(['/a', 'a/b', '//example.com/a'])('warns for relative "%s"', (href) => {
    expect(checkCanonical(link(href)).status).toBe('warn');
  });

  it('fails when missing or empty', () => {
    expect(checkCanonical(load('<html></html>')).status).toBe('fail');
    expect(checkCanonical(link('')).status).toBe('fail');
  });
});

describe('robots-txt', () => {
  it('passes for a 200 text file', () => {
    expect(checkRobotsTxt(text({ body: 'User-agent: *\nDisallow:' })).status).toBe('pass');
  });

  it('fails for 404, network failure and HTML', () => {
    expect(checkRobotsTxt(text({ status: 404 })).status).toBe('fail');
    expect(checkRobotsTxt(text({ status: null })).status).toBe('fail');
    expect(checkRobotsTxt(text({ contentType: 'text/html; charset=utf-8' })).status).toBe('fail');
    expect(checkRobotsTxt(text({ body: '<!DOCTYPE html><html>' })).status).toBe('fail');
  });
});

describe('sitemap', () => {
  it('extracts Sitemap lines case-insensitively and ignores invalid ones', () => {
    const robots = [
      'User-agent: *',
      'Sitemap: https://example.com/a.xml',
      'sitemap:https://example.com/b.xml',
      'Sitemap: /relative.xml',
      'Sitemap: ftp://example.com/c.xml',
    ].join('\r\n');
    expect(extractSitemapUrls(robots)).toEqual([
      'https://example.com/a.xml',
      'https://example.com/b.xml',
    ]);
  });

  it('uses the Sitemap directive, else /sitemap.xml', () => {
    const page = 'https://example.com/deep/page';
    expect(resolveSitemapUrl(page, text({ body: 'Sitemap: https://cdn.example.com/s.xml' }))).toBe(
      'https://cdn.example.com/s.xml',
    );
    expect(resolveSitemapUrl(page, text({ body: 'User-agent: *' }))).toBe(
      'https://example.com/sitemap.xml',
    );
    expect(
      resolveSitemapUrl(page, text({ status: 404, body: 'Sitemap: https://x.com/s.xml' })),
    ).toBe('https://example.com/sitemap.xml');
  });

  it('passes for urlset and sitemapindex', () => {
    expect(
      checkSitemap(text({ body: '<?xml version="1.0"?><urlset xmlns="x"></urlset>' })).status,
    ).toBe('pass');
    expect(checkSitemap(text({ body: '<sitemapindex></sitemapindex>' })).status).toBe('pass');
  });

  it.each([
    { url: 'https://example.com/sitemap.xml.gz', contentType: 'application/octet-stream' },
    { url: 'https://example.com/sitemap', contentType: 'application/x-gzip' },
    { url: 'https://example.com/sitemap', contentType: 'application/gzip' },
  ])('passes a gzipped sitemap without inspecting it ($url, $contentType)', (overrides) => {
    const r = checkSitemap(text({ ...overrides, body: '\x1f\x8b\b' }));
    expect(r.status).toBe('pass');
    expect(r.message).toContain('not inspected');
  });

  it('warns for a 200 that is not a sitemap', () => {
    expect(checkSitemap(text({ body: '<html>home</html>' })).status).toBe('warn');
  });

  it('fails for 404 and network failure', () => {
    expect(checkSitemap(text({ status: 404 })).status).toBe('fail');
    expect(checkSitemap(text({ status: null })).status).toBe('fail');
  });
});

describe('runSeoChecks', () => {
  const ok = text({ body: '<urlset></urlset>' });

  it('passes everything for a good page', () => {
    const results = runSeoChecks({
      $: fixture('good.html'),
      status: 200,
      robots: text(),
      sitemap: ok,
    });
    expect(results.map((r) => r.id)).toEqual([
      'title',
      'meta-description',
      'h1',
      'canonical-url',
      'robots-txt',
      'sitemap-xml',
    ]);
    expect(results.every((r) => r.status === 'pass')).toBe(true);
    expect(results.reduce((s, r) => s + r.maxPoints, 0)).toBe(20);
  });

  it('reports a bad page', () => {
    const results = runSeoChecks({
      $: fixture('bad.html'),
      status: 200,
      robots: text(),
      sitemap: ok,
    });
    const status = Object.fromEntries(results.map((r) => [r.id, r.status]));
    expect(status).toMatchObject({
      title: 'warn',
      'meta-description': 'fail',
      h1: 'warn',
      'canonical-url': 'fail',
    });
  });

  it('fails page checks for non-HTML but still runs robots and sitemap', () => {
    const results = runSeoChecks({ $: null, status: 200, robots: text(), sitemap: ok });
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId['title']?.status).toBe('fail');
    expect(byId['title']?.message).toBe('Response is not HTML');
    expect(byId['robots-txt']?.status).toBe('pass');
    expect(byId['sitemap-xml']?.status).toBe('pass');
  });

  it('skips page checks for an error page but still runs robots and sitemap', () => {
    const results = runSeoChecks({
      $: fixture('good.html'),
      status: 403,
      robots: text(),
      sitemap: ok,
    });
    const status = Object.fromEntries(results.map((r) => [r.id, r.status]));
    expect(status).toEqual({
      title: 'skip',
      'meta-description': 'skip',
      h1: 'skip',
      'canonical-url': 'skip',
      'robots-txt': 'pass',
      'sitemap-xml': 'pass',
    });
  });

  it('copes with empty and broken HTML', () => {
    for (const html of ['', '<<<>>>', '<html><head><title>unclosed']) {
      const results = runSeoChecks({ $: load(html), status: 200, robots: text(), sitemap: ok });
      expect(results.some((r) => r.status === 'error')).toBe(false);
    }
  });
});
