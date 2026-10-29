import { readFileSync } from 'node:fs';
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import {
  checkAriaValid,
  checkAutocomplete,
  checkButtonName,
  checkFormLabel,
  checkHeadingStructure,
  checkHtmlLang,
  checkHtmlLangValid,
  checkIframeTitle,
  checkImageAlt,
  checkLandmarks,
  checkLinkName,
  checkMediaAutoplay,
  checkMetaRefresh,
  checkTableHeaders,
  checkTabindex,
  checkZoomAllowed,
  runAccessibilityChecks,
} from '../src/checks/accessibility.js';

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

describe('link-name', () => {
  it.each([
    ['<a href="/a">Text</a>', 'pass'],
    ['<a href="/a" aria-label="Home"></a>', 'pass'],
    ['<a href="/a"><img src="x" alt="Logo"></a>', 'pass'],
    ['<a href="/a"><svg><title>Home</title></svg></a>', 'pass'],
    ['<a href="/a" title="Home"></a>', 'pass'],
    ['<span id="l">Home</span><a href="/a" aria-labelledby="l"></a>', 'pass'],
    ['<a name="anchor"></a>', 'pass'],
    ['<a href="/a"></a>', 'fail'],
    ['<a href="/a"><img src="x" alt=""></a>', 'fail'],
    ['<a href="/a" aria-labelledby="missing"></a>', 'fail'],
    ['<a href="/a">  </a>', 'fail'],
    ['<a href="/a"><span aria-label="Home"></span></a>', 'pass'],
    ['<span id="l" aria-label="Home"></span><a href="/a" aria-labelledby="l"></a>', 'pass'],
    ['<span id="l" aria-hidden="true">Home</span><a href="/a" aria-labelledby="l"></a>', 'pass'],
    ['<a href="/a"><span aria-hidden="TRUE">→</span>Next</a>', 'pass'],
    ['<a href="/a" aria-hidden="true" tabindex="-1"></a>', 'pass'],
    ['<a href="#" role="button"></a>', 'pass'],
    ['<a href="/a"><span aria-hidden="true">→</span></a>', 'fail'],
    ['<a href="/a"><img src="x" alt="Logo" aria-hidden="true"></a>', 'fail'],
  ])('%s -> %s', (html, status) => {
    expect(checkLinkName(load(html)).status).toBe(status);
  });

  it('warns up to 20 percent unnamed, fails above', () => {
    const links = (bad: number) =>
      load('<a href="/a">x</a>'.repeat(10 - bad) + '<a href="/b"></a>'.repeat(bad));
    expect(checkLinkName(links(2)).status).toBe('warn');
    expect(checkLinkName(links(3)).status).toBe('fail');
    expect(checkLinkName(links(3)).message).toBe('3 of 10 links have no accessible name');
  });

  it('stays fast with many aria-labelledby references', () => {
    let html = '';
    for (let i = 0; i < 5000; i++)
      html += `<span id="l${i}">L</span><a href="/" aria-labelledby="l${i}"></a>`;
    const $ = load(html);
    const start = performance.now();
    expect(checkLinkName($).status).toBe('pass');
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe('button-name', () => {
  it.each([
    ['<button>Save</button>', 'pass'],
    ['<button aria-label="Close">×</button>', 'pass'],
    ['<input type="submit">', 'pass'],
    ['<input type="reset">', 'pass'],
    ['<input type="button" value="Go">', 'pass'],
    ['<input type="image" alt="Search">', 'pass'],
    ['<div role="button">Menu</div>', 'pass'],
    ['<p>no buttons</p>', 'pass'],
    ['<button></button>', 'fail'],
    ['<input type="button">', 'fail'],
    ['<input type="image">', 'fail'],
    ['<div role="button"></div>', 'fail'],
    ['<span id="l" aria-label="Close"></span><button aria-labelledby="l"></button>', 'pass'],
    ['<div aria-hidden="true"><button></button></div>', 'pass'],
    ['<button><img src="x" alt="Close" aria-hidden="true"></button>', 'fail'],
    ['<button><script>close()</script></button>', 'fail'],
    ['<a href="#" role="button"></a>', 'fail'],
  ])('%s -> %s', (html, status) => {
    expect(checkButtonName(load(html)).status).toBe(status);
  });
});

describe('form-label', () => {
  it.each([
    ['<label for="a">A</label><input id="a">', 'pass'],
    ['<label>A <input></label>', 'pass'],
    ['<label>A <select><option>1</option></select></label>', 'pass'],
    ['<input aria-label="A">', 'pass'],
    ['<span id="s">A</span><textarea aria-labelledby="s"></textarea>', 'pass'],
    ['<input type="hidden">', 'pass'],
    ['<input type="submit"><input type="button"><input type="image">', 'pass'],
    ['<p>no fields</p>', 'pass'],
    ['<input>', 'fail'],
    ['<input type="email" placeholder="Email">', 'fail'],
    ['<label for="other">A</label><input id="a">', 'fail'],
    ['<select></select>', 'fail'],
  ])('%s -> %s', (html, status) => {
    expect(checkFormLabel(load(html)).status).toBe(status);
  });
});

describe('iframe-title', () => {
  it.each([
    ['<iframe title="Map"></iframe>', 'pass'],
    ['<iframe aria-label="Map"></iframe>', 'pass'],
    ['<p>none</p>', 'pass'],
    ['<iframe></iframe>', 'fail'],
    ['<iframe title="  "></iframe>', 'fail'],
    ['<iframe title="A"></iframe><iframe></iframe>', 'fail'],
    ['<iframe aria-hidden="true" tabindex="-1"></iframe>', 'pass'],
    ['<div aria-hidden="true"><iframe></iframe></div><iframe title="A"></iframe>', 'pass'],
  ])('%s -> %s', (html, status) => {
    expect(checkIframeTitle(load(html)).status).toBe(status);
  });
});

describe('landmarks', () => {
  it.each([
    ['<main></main>', 'pass'],
    ['<div role="main"></div>', 'pass'],
    ['<main></main><div role="main"></div>', 'warn'],
    ['<main></main><main></main>', 'warn'],
    ['<main></main><main hidden></main>', 'pass'],
    ['<main></main><div hidden><div role="main"></div></div>', 'pass'],
    ['<main hidden></main>', 'fail'],
    ['<div></div>', 'fail'],
  ])('%s -> %s', (html, status) => {
    expect(checkLandmarks(load(html)).status).toBe(status);
  });
});

describe('aria-valid', () => {
  it.each([
    ['<div role="button"></div>', 'pass'],
    ['<div role="Navigation"></div>', 'pass'],
    ['<div role="doc-toc button"></div>', 'pass'],
    ['<a role="doc-noteref" href="#n">1</a><svg role="graphics-document"></svg>', 'pass'],
    ['<p id="a">x</p><div aria-labelledby="a" aria-describedby="a"></div>', 'pass'],
    ['<div aria-controls="gone" aria-expanded="false"></div>', 'pass'],
    ['<div aria-hidden="true"><span>decor</span></div>', 'pass'],
    ['<div aria-hidden="true"><a href="/a" tabindex="-1">x</a></div>', 'pass'],
    ['<div aria-hidden="true"><button disabled>x</button></div>', 'pass'],
    ['<div role="bogus"></div>', 'fail'],
    ['<div aria-labelledby="gone"></div>', 'fail'],
    ['<p id="a"></p><div aria-describedby="a gone"></div>', 'fail'],
    ['<div aria-controls="gone"></div>', 'fail'],
    ['<a href="/a" aria-hidden="true">x</a>', 'fail'],
    ['<div aria-hidden="true"><input></div>', 'fail'],
    ['<div aria-hidden="TRUE"><a href="/a">x</a></div>', 'fail'],
  ])('%s -> %s', (html, status) => {
    expect(checkAriaValid(load(html)).status).toBe(status);
  });

  it('summarises the problems and caps the list', () => {
    const html = '<div role="a"></div><div role="b"></div><div role="c"></div><div role="d"></div>';
    expect(checkAriaValid(load(html)).message).toBe(
      '4 ARIA problems: invalid role "a"; invalid role "b"; invalid role "c"; +1 more',
    );
  });

  it('escapes control characters from the page', () => {
    expect(checkAriaValid(load('<div role="a&#27;[2J"></div>')).message).not.toContain('\x1b');
  });
});

describe('zoom-allowed', () => {
  const vp = (content: string) => load(`<meta name="viewport" content="${content}">`);

  it.each([
    ['width=device-width, initial-scale=1', 'pass'],
    ['width=device-width, maximum-scale=5', 'pass'],
    ['width=device-width, maximum-scale=2', 'pass'],
    ['width=device-width, user-scalable=yes', 'pass'],
    ['width=device-width, user-scalable=no', 'fail'],
    ['width=device-width, user-scalable=0', 'fail'],
    ['width=device-width; USER-SCALABLE = NO', 'fail'],
    ['width=device-width, maximum-scale=1', 'fail'],
    ['width=device-width, maximum-scale=1.5', 'fail'],
  ])('%s -> %s', (content, status) => {
    expect(checkZoomAllowed(vp(content)).status).toBe(status);
  });

  it('passes without a viewport meta tag', () => {
    expect(checkZoomAllowed(load('<p>x</p>')).status).toBe('pass');
  });
});

describe('tabindex', () => {
  it.each([
    ['<div tabindex="0"></div><div tabindex="-1"></div>', 'pass'],
    ['<p>none</p>', 'pass'],
    ['<div tabindex="abc"></div>', 'pass'],
    ['<div tabindex="1"></div>', 'fail'],
    ['<a href="/a" tabindex="5">x</a>', 'fail'],
  ])('%s -> %s', (html, status) => {
    expect(checkTabindex(load(html)).status).toBe(status);
  });
});

describe('meta-refresh', () => {
  const refresh = (content: string) => load(`<meta http-equiv="refresh" content="${content}">`);

  it.each([
    ['0', 'pass'],
    ['0; url=/new', 'pass'],
    ['soon', 'pass'],
    ['5', 'fail'],
    ['30; url=/new', 'fail'],
    ['1.5', 'fail'],
    ['72000', 'fail'],
    ['72001', 'pass'],
  ])('content="%s" -> %s', (content, status) => {
    expect(checkMetaRefresh(refresh(content)).status).toBe(status);
  });

  it('passes without a meta refresh', () => {
    expect(checkMetaRefresh(load('<p>x</p>')).status).toBe('pass');
  });
});

describe('table-headers', () => {
  it.each([
    ['<table><tr><th>A</th></tr><tr><td>1</td></tr></table>', 'pass'],
    ['<table><tr><td>1</td></tr></table>', 'fail'],
    ['<table role="presentation"><tr><td>1</td></tr></table>', 'pass'],
    ['<table role="none"><tr><td>1</td></tr></table>', 'pass'],
    ['<table aria-hidden="true"><tr><td>1</td></tr></table>', 'pass'],
    ['<p>no tables</p>', 'pass'],
  ])('%s -> %s', (html, status) => {
    expect(checkTableHeaders(load(html)).status).toBe(status);
  });

  it('warns when at most 20 % of the tables lack headers', () => {
    const good = '<table><tr><th>A</th></tr></table>'.repeat(4);
    const result = checkTableHeaders(load(`${good}<table><tr><td>1</td></tr></table>`));
    expect(result.status).toBe('warn');
    expect(result.message).toBe('1 of 5 tables have no header cells');
  });
});

describe('autocomplete', () => {
  it.each([
    ['<input type="email" autocomplete="email">', 'pass'],
    ['<input type="email">', 'fail'],
    ['<input type="tel" autocomplete="off">', 'fail'],
    ['<input type="email" autocomplete="on">', 'fail'],
    ['<input type="text" name="first_name">', 'fail'],
    ['<input type="text" name="first_name" autocomplete="given-name">', 'pass'],
    ['<input id="postal-code">', 'fail'],
    ['<input type="text" name="q">', 'pass'],
    ['<input type="hidden" name="email">', 'pass'],
    ['<input type="email" disabled>', 'pass'],
    ['<input type="email" aria-hidden="true">', 'pass'],
    ['<div hidden><input type="email"></div>', 'pass'],
  ])('%s -> %s', (html, status) => {
    expect(checkAutocomplete(load(html)).status).toBe(status);
  });

  it('warns when at most 20 % of the fields lack a token', () => {
    const good = '<input type="email" autocomplete="email">'.repeat(4);
    const result = checkAutocomplete(load(`${good}<input type="tel">`));
    expect(result.status).toBe('warn');
    expect(result.message).toBe('1 of 5 personal data fields have no autocomplete token');
  });
});

describe('media-autoplay', () => {
  it.each([
    ['<video autoplay muted></video>', 'pass'],
    ['<video controls></video>', 'pass'],
    ['<video autoplay controls></video>', 'pass'],
    ['<video autoplay></video>', 'fail'],
    ['<audio autoplay></audio>', 'fail'],
  ])('%s -> %s', (html, status) => {
    expect(checkMediaAutoplay(load(html)).status).toBe(status);
  });
});

describe('html-lang-valid', () => {
  const status = (lang: string) => checkHtmlLangValid(load(`<html lang="${lang}"></html>`)).status;

  it.each([
    'en',
    'sv-SE',
    'zh-Hant-TW',
    'es-419',
    'de-CH-1996',
    'en-u-ca-gregory',
    'x-private',
    'EN-us',
  ])('passes %s', (lang) => expect(status(lang)).toBe('pass'));

  it.each(['english', 'en_US', 'e', 'en--US', 'en-', 'sv SE', '123'])('fails %s', (lang) =>
    expect(status(lang)).toBe('fail'),
  );

  it('skips a missing lang so html-lang is not repeated', () => {
    expect(checkHtmlLangValid(load('<html></html>')).status).toBe('skip');
  });

  it('gives remediation on failure', () => {
    expect(checkHtmlLangValid(load('<html lang="english"></html>')).remediation).toMatch(/BCP 47/);
  });
});

describe('runAccessibilityChecks', () => {
  const ids = [
    'html-lang',
    'html-lang-valid',
    'image-alt',
    'heading-structure',
    'link-name',
    'button-name',
    'form-label',
    'iframe-title',
    'landmarks',
    'aria-valid',
    'zoom-allowed',
    'tabindex',
    'meta-refresh',
    'table-headers',
    'autocomplete',
    'media-autoplay',
  ];

  it('passes everything for a good page', () => {
    const results = runAccessibilityChecks({ $: fixture('good.html'), status: 200 });
    expect(results.map((r) => r.id)).toEqual(ids);
    expect(results.every((r) => r.status === 'pass')).toBe(true);
    expect(results.every((r) => r.category === 'accessibility')).toBe(true);
    expect(results.reduce((s, r) => s + r.maxPoints, 0)).toBe(47);
  });

  it('gives every result a WCAG reference', () => {
    const results = runAccessibilityChecks({ $: fixture('good.html'), status: 200 });
    for (const r of results) expect(r.wcag?.length).toBeGreaterThan(0);
    expect(results.find((r) => r.id === 'link-name')?.wcag).toEqual(['2.4.4', '4.1.2']);
  });

  it('reports a bad page', () => {
    const status = Object.fromEntries(
      runAccessibilityChecks({ $: fixture('bad.html'), status: 200 }).map((r) => [r.id, r.status]),
    );
    expect(status).toEqual({
      'html-lang': 'fail',
      'html-lang-valid': 'skip',
      'image-alt': 'fail',
      'heading-structure': 'warn',
      'link-name': 'fail',
      'button-name': 'fail',
      'form-label': 'fail',
      'iframe-title': 'fail',
      landmarks: 'fail',
      'aria-valid': 'fail',
      'zoom-allowed': 'fail',
      tabindex: 'fail',
      'meta-refresh': 'fail',
      'table-headers': 'fail',
      autocomplete: 'fail',
      'media-autoplay': 'fail',
    });
  });

  it('fails every check for non-HTML', () => {
    const results = runAccessibilityChecks({ $: null, status: 200 });
    expect(results.every((r) => r.status === 'fail' && r.message === 'Response is not HTML')).toBe(
      true,
    );
  });

  it.each([404, 403, 500, 304])('skips every check when the page responded %i', (status) => {
    const results = runAccessibilityChecks({ $: fixture('good.html'), status });
    for (const r of results) {
      expect(r).toMatchObject({
        status: 'skip',
        message: `Skipped ${r.id}: page responded with HTTP ${status}`,
        points: 0,
      });
    }
  });

  it('copes with empty and broken HTML', () => {
    for (const html of ['', '<<<>>>', '<html><img', '<a href><button><input', '<div role>']) {
      const results = runAccessibilityChecks({ $: load(html), status: 200 });
      expect(results.some((r) => r.status === 'error')).toBe(false);
    }
  });
});
