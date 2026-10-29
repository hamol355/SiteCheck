import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import {
  checkCanonical,
  checkCharset,
  checkDoctype,
  checkDuplicateDescriptions,
  checkDuplicateTitles,
  checkH1,
  checkHreflang,
  checkOpenGraph,
  runSeoCrossPageChecks,
  checkStructuredData,
  checkIndexable,
  checkMetaDescription,
  checkRobotsTxt,
  checkSitemap,
  checkTitle,
  checkViewport,
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

describe('viewport-meta', () => {
  const vp = (content: string) => load(`<meta name="viewport" content="${content}">`);

  it('passes with width=device-width', () => {
    expect(checkViewport(vp('width=device-width, initial-scale=1')).status).toBe('pass');
    expect(checkViewport(vp('width = device-width')).status).toBe('pass');
  });

  it('warns without it and fails when missing', () => {
    expect(checkViewport(vp('initial-scale=1')).status).toBe('warn');
    expect(checkViewport(load('<html></html>')).status).toBe('fail');
  });
});

describe('indexable', () => {
  const page = (head: string) => load(`<html><head>${head}</head></html>`);

  it('passes without robots directives, or with index/follow', () => {
    expect(checkIndexable(page('')).status).toBe('pass');
    expect(checkIndexable(page('<meta name="robots" content="index, follow">')).status).toBe(
      'pass',
    );
  });

  it('fails on noindex or none in the meta tag', () => {
    expect(checkIndexable(page('<meta name="robots" content="noindex, follow">')).status).toBe(
      'fail',
    );
    expect(checkIndexable(page('<meta name="ROBOTS" content="None">')).status).toBe('fail');
    expect(
      checkIndexable(page('<meta name="robots" content="noindex">')).remediation,
    ).toBeDefined();
  });

  it('fails on noindex in X-Robots-Tag', () => {
    expect(checkIndexable(page(''), { 'x-robots-tag': 'noindex' }).status).toBe('fail');
    expect(checkIndexable(page(''), { 'x-robots-tag': 'nofollow, noindex' }).status).toBe('fail');
  });

  it('warns on nofollow without noindex', () => {
    expect(checkIndexable(page('<meta name="robots" content="nofollow">')).status).toBe('warn');
    expect(checkIndexable(page(''), { 'x-robots-tag': 'nofollow' }).status).toBe('warn');
  });

  it('ignores directives for a specific crawler and meta name=googlebot', () => {
    expect(checkIndexable(page(''), { 'x-robots-tag': 'googlebot: noindex' }).status).toBe('pass');
    expect(checkIndexable(page('<meta name="googlebot" content="noindex">')).status).toBe('pass');
  });

  it('keeps a crawler scope across comma-joined headers but resets on a new prefix', () => {
    const joined = 'googlebot: noindex, nofollow, bingbot: noarchive';
    expect(checkIndexable(page(''), { 'x-robots-tag': joined }).status).toBe('pass');
    expect(
      checkIndexable(page(''), { 'x-robots-tag': 'googlebot: nofollow, all: noindex' }).status,
    ).toBe('fail');
  });

  it('does not mistake unavailable_after for a crawler prefix', () => {
    const header = { 'x-robots-tag': 'unavailable_after: 25 Jun 2030 15:00:00 PST' };
    expect(checkIndexable(page(''), header).status).toBe('pass');
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
      'viewport-meta',
      'indexable',
      'open-graph',
      'structured-data',
      'hreflang',
      'charset',
      'doctype',
      'robots-txt',
      'sitemap-xml',
    ]);
    expect(results.every((r) => r.status === 'pass')).toBe(true);
    expect(results.reduce((s, r) => s + r.maxPoints, 0)).toBe(38);
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
      'viewport-meta': 'warn',
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
      'viewport-meta': 'skip',
      indexable: 'skip',
      'open-graph': 'skip',
      'structured-data': 'skip',
      hreflang: 'skip',
      charset: 'skip',
      doctype: 'skip',
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

describe('open-graph', () => {
  const run = (head: string) => checkOpenGraph(load(`<html><head>${head}</head></html>`));
  const tag = (p: string) => `<meta property="og:${p}" content="x">`;

  it('passes with title, description and image', () => {
    expect(run(tag('title') + tag('description') + tag('image')).status).toBe('pass');
  });
  it('warns when some are missing and fails when none exist', () => {
    expect(run(tag('title')).status).toBe('warn');
    expect(run('<meta property="og:title" content=" ">').status).toBe('fail');
    expect(run('').status).toBe('fail');
  });
});

describe('structured-data', () => {
  const run = (body: string) => checkStructuredData(load(`<html><body>${body}</body></html>`));
  const ld = (json: string) => `<script type="application/ld+json">${json}</script>`;

  it('passes without blocks and with valid ones', () => {
    expect(run('').status).toBe('pass');
    expect(run(ld('{"@context":"https://schema.org","@type":"Organization"}')).status).toBe('pass');
    expect(
      run(
        ld(
          '[{"@context":"https://schema.org","@type":"A"},{"@context":"https://schema.org","@type":"B"}]',
        ),
      ).status,
    ).toBe('pass');
    expect(run(ld('{"@context":"https://schema.org","@graph":[{"@type":"A"}]}')).status).toBe(
      'pass',
    );
  });
  it('fails on broken JSON or a missing @type', () => {
    expect(run(ld('{not json')).status).toBe('fail');
    expect(run(ld('{"@context":"https://schema.org"}')).status).toBe('fail');
    expect(run(ld('"text"')).status).toBe('fail');
  });
  it('fails on a missing @context or @graph nodes without @type', () => {
    expect(run(ld('{"@type":"Thing"}')).status).toBe('fail');
    expect(run(ld('{"@context":"https://schema.org","@graph":[1,2]}')).status).toBe('fail');
    expect(run(ld('{"@context":"https://schema.org","@graph":[{"name":"x"}]}')).status).toBe(
      'fail',
    );
  });
});

describe('hreflang', () => {
  const run = (links: string) => checkHreflang(load(`<html><head>${links}</head></html>`));
  const alt = (lang: string, href = 'https://example.com/') =>
    `<link rel="alternate" hreflang="${lang}" href="${href}">`;

  it('passes with none or valid annotations', () => {
    expect(run('').status).toBe('pass');
    expect(run(alt('en') + alt('sv-SE') + alt('x-default')).status).toBe('pass');
    expect(run(alt('zh-Hant-TW') + alt('es-419')).status).toBe('pass');
  });
  it('fails on an invalid tag or a relative href', () => {
    expect(run(alt('english')).status).toBe('fail');
    expect(run(alt('en_US')).status).toBe('fail');
    expect(run(alt('en', '/en/')).status).toBe('fail');
    expect(run(alt('en-US-US')).status).toBe('fail');
    expect(run(alt('e')).status).toBe('fail');
  });
});

describe('charset', () => {
  it('passes with meta charset, http-equiv or a Content-Type header', () => {
    expect(checkCharset(load('<meta charset="utf-8">')).status).toBe('pass');
    expect(
      checkCharset(load('<meta http-equiv="Content-Type" content="text/html; charset=utf-8">'))
        .status,
    ).toBe('pass');
    expect(
      checkCharset(load('<p>x</p>'), { 'content-type': 'text/html; charset=UTF-8' }).status,
    ).toBe('pass');
  });
  it('fails when the meta declaration is past the first 1024 bytes', () => {
    const late = `<!DOCTYPE html><head><!-- ${'x'.repeat(1100)} --><meta charset="utf-8"></head>`;
    const r = checkCharset(load(late), {}, late);
    expect(r.status).toBe('fail');
    expect(r.message).toContain('1024');
    const early = '<!DOCTYPE html><head><meta charset="utf-8"></head>';
    expect(checkCharset(load(early), {}, early).status).toBe('pass');
    expect(
      checkCharset(load(late), { 'content-type': 'text/html; charset=utf-8' }, late).status,
    ).toBe('pass');
  });
  it('fails when no encoding is declared', () => {
    expect(checkCharset(load('<p>x</p>'), { 'content-type': 'text/html' }).status).toBe('fail');
  });
});

describe('doctype', () => {
  it.each([
    ['<!DOCTYPE html><html></html>', 'pass'],
    ['<!doctype HTML><html></html>', 'pass'],
    ['<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN"><html></html>', 'warn'],
    ['<html></html>', 'fail'],
  ])('%s -> %s', (html, status) => {
    expect(checkDoctype(load(html)).status).toBe(status);
  });
});

describe('duplicate-titles and duplicate-descriptions', () => {
  it('skip with a single page or fewer than two values', () => {
    expect(checkDuplicateTitles(['A']).status).toBe('skip');
    expect(checkDuplicateTitles(['A', '']).status).toBe('skip');
  });
  it('pass when all are unique, ignoring pages without one', () => {
    expect(checkDuplicateTitles(['A', 'B', '']).status).toBe('pass');
  });
  it('warns up to 20 % of pages sharing, fails above', () => {
    const unique = ['b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    expect(checkDuplicateTitles(['a', 'a', ...unique]).status).toBe('warn');
    expect(checkDuplicateTitles(['a', 'a', 'a', ...unique]).status).toBe('fail');
    expect(checkDuplicateTitles(['a', 'a', 'a', ...unique]).remediation).toBeDefined();
  });
  it('works for descriptions', () => {
    expect(checkDuplicateDescriptions(['x', 'x']).status).toBe('fail');
    expect(checkDuplicateDescriptions(['x', 'y']).id).toBe('duplicate-descriptions');
  });
});

describe('canonical-url across origins', () => {
  const run = (href: string) =>
    checkCanonical(load(`<link rel="canonical" href="${href}">`), 'https://example.com/page');

  it('passes for the same origin and warns for another', () => {
    expect(run('https://example.com/page').status).toBe('pass');
    expect(run('https://other.example.net/page').status).toBe('warn');
  });
});

describe('runSeoCrossPageChecks', () => {
  it('compares titles and descriptions of the analysed pages', () => {
    const results = runSeoCrossPageChecks([
      { title: 'Same', description: 'a' },
      { title: 'Same', description: 'b' },
    ]);
    expect(results.map((r) => [r.id, r.status])).toEqual([
      ['duplicate-titles', 'fail'],
      ['duplicate-descriptions', 'pass'],
    ]);
  });
});
