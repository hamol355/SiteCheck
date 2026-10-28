import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import {
  checkHeadingStructure,
  checkHtmlLang,
  checkImageAlt,
  checkViewport,
  runHtmlChecks,
} from '../src/checks/html.js';

const load = (html: string) => cheerio.load(html);
const fixture = (name: string) =>
  load(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

describe('html-lang', () => {
  it('passes with a lang, fails when missing or blank', () => {
    expect(checkHtmlLang(load('<html lang="sv"></html>')).status).toBe('pass');
    expect(checkHtmlLang(load('<html></html>')).status).toBe('fail');
    expect(checkHtmlLang(load('<html lang="  "></html>')).status).toBe('fail');
  });

  it('escapes control characters from the page in the message', () => {
    const r = checkHtmlLang(load('<html lang="en&#27;[2J"></html>'));
    expect(r.message).toBe('Document language is "en\\x1b[2J"');
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

describe('image-alt', () => {
  const imgs = (n: number, missing: number) =>
    load(
      Array.from({ length: n }, (_, i) =>
        i < missing ? '<img src="a">' : '<img src="a" alt="x">',
      ).join(''),
    );

  it('passes with no images and with empty alt', () => {
    expect(checkImageAlt(load('<p>hi</p>')).status).toBe('pass');
    expect(checkImageAlt(load('<img src="a" alt="">')).status).toBe('pass');
  });

  it('warns up to 20 percent missing, fails above', () => {
    const warn = checkImageAlt(imgs(10, 2));
    expect(warn.status).toBe('warn');
    expect(warn.message).toContain('2 images are missing alt attributes');
    expect(checkImageAlt(imgs(10, 3)).status).toBe('fail');
  });

  it('uses singular wording for one image', () => {
    expect(checkImageAlt(imgs(10, 1)).message).toContain('1 image is missing');
  });
});

describe('heading-structure', () => {
  it.each([
    ['<h1>a</h1><h2>b</h2><h3>c</h3><h2>d</h2>', 'pass'],
    ['<h1>a</h1><h3>c</h3>', 'warn'],
    ['<h2>a</h2><h3>b</h3>', 'pass'],
    ['<h3>a</h3><h1>b</h1><h2>c</h2>', 'pass'],
    ['<h2>a</h2><h4>b</h4>', 'warn'],
    ['<h1>a</h1><h2>b</h2><h4>c</h4>', 'warn'],
    ['<p>none</p>', 'fail'],
  ])('%s -> %s', (html, status) => {
    expect(checkHeadingStructure(load(html)).status).toBe(status);
  });

  it('names the skipped levels', () => {
    expect(checkHeadingStructure(load('<h1>a</h1><h2>b</h2><h4>c</h4>')).message).toBe(
      'Heading level skips from <h2> to <h4>',
    );
  });
});

describe('runHtmlChecks', () => {
  it('passes everything for a good page', () => {
    const results = runHtmlChecks({ $: fixture('good.html'), status: 200 });
    expect(results.map((r) => r.id)).toEqual([
      'html-lang',
      'viewport-meta',
      'image-alt',
      'heading-structure',
    ]);
    expect(results.every((r) => r.status === 'pass')).toBe(true);
    expect(results.reduce((s, r) => s + r.maxPoints, 0)).toBe(20);
  });

  it('reports a bad page', () => {
    const status = Object.fromEntries(
      runHtmlChecks({ $: fixture('bad.html'), status: 200 }).map((r) => [r.id, r.status]),
    );
    expect(status).toEqual({
      'html-lang': 'fail',
      'viewport-meta': 'warn',
      'image-alt': 'fail',
      'heading-structure': 'warn',
    });
  });

  it('fails every check for non-HTML', () => {
    const results = runHtmlChecks({ $: null, status: 200 });
    expect(results.every((r) => r.status === 'fail' && r.message === 'Response is not HTML')).toBe(
      true,
    );
  });

  it.each([404, 403, 500, 304])('skips every check when the page responded %i', (status) => {
    const results = runHtmlChecks({ $: fixture('good.html'), status });
    for (const r of results) {
      expect(r).toMatchObject({
        status: 'skip',
        message: `Skipped ${r.id}: page responded with HTTP ${status}`,
        points: 0,
      });
    }
  });

  it('copes with empty and broken HTML', () => {
    for (const html of ['', '<<<>>>', '<html><img']) {
      expect(runHtmlChecks({ $: load(html), status: 200 }).some((r) => r.status === 'error')).toBe(
        false,
      );
    }
  });
});
