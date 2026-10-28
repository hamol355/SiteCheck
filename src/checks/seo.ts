import type { CheerioAPI } from 'cheerio';
import { quoteUntrusted } from '../text.js';
import { makeResult, safeRun, safeRunPage, type PageInput } from './run.js';
import type { CheckDefinition, CheckResult, TextResponse } from './types.js';

export const TITLE_MAX_LENGTH = 60;
export const DESCRIPTION_MIN_LENGTH = 50;
export const DESCRIPTION_MAX_LENGTH = 160;

const def = (id: string, maxPoints: number): CheckDefinition => ({
  id,
  category: 'seo',
  maxPoints,
});

const TITLE = def('title', 4);
const META_DESCRIPTION = def('meta-description', 4);
const H1 = def('h1', 3);
const CANONICAL = def('canonical-url', 3);
const ROBOTS = def('robots-txt', 3);
const SITEMAP = def('sitemap-xml', 3);

/** Collapses whitespace runs like browsers do for document.title, so line breaks and indentation are not counted. */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function lengthResult(
  checkDef: CheckDefinition,
  label: string,
  text: string,
  min: number | undefined,
  max: number,
  remediation: string,
): CheckResult {
  if (text === '') {
    return makeResult(checkDef, 'fail', `Missing ${label}`, remediation);
  }
  const message = `${label[0]?.toUpperCase()}${label.slice(1)} is ${text.length} characters`;
  if (text.length >= (min ?? 0) && text.length <= max) {
    return makeResult(checkDef, 'pass', message);
  }
  const range = min === undefined ? `at most ${max}` : `${min}-${max}`;
  return makeResult(
    checkDef,
    'warn',
    `${message} (recommended ${range})`,
    min === undefined
      ? `Keep the ${label} to ${max} characters or fewer.`
      : `Keep the ${label} between ${min} and ${max} characters.`,
  );
}

export function checkTitle($: CheerioAPI): CheckResult {
  // <title> inside inline SVG labels the icon, not the page.
  const element = $('title')
    .filter((_, el) => $(el).closest('svg').length === 0)
    .first();
  const title = normalizeText(element.text());
  return lengthResult(
    TITLE,
    'title',
    title,
    undefined,
    TITLE_MAX_LENGTH,
    'Add a descriptive <title> element to the <head>.',
  );
}

export function checkMetaDescription($: CheerioAPI): CheckResult {
  const description = normalizeText($('meta[name="description" i]').first().attr('content') ?? '');
  return lengthResult(
    META_DESCRIPTION,
    'meta description',
    description,
    DESCRIPTION_MIN_LENGTH,
    DESCRIPTION_MAX_LENGTH,
    'Add <meta name="description" content="..."> to the <head>.',
  );
}

export function checkH1($: CheerioAPI): CheckResult {
  const count = $('h1').length;
  if (count === 1) return makeResult(H1, 'pass', 'Page has exactly one <h1>');
  if (count === 0) {
    return makeResult(H1, 'fail', 'Page has no <h1>', 'Add one <h1> that describes the page.');
  }
  return makeResult(
    H1,
    'warn',
    `Page has ${count} <h1> elements`,
    'Use a single <h1> per page and <h2>-<h6> for sub-sections.',
  );
}

export function checkCanonical($: CheerioAPI): CheckResult {
  const href = ($('link[rel~="canonical" i]').first().attr('href') ?? '').trim();
  const remediation = 'Add <link rel="canonical" href="https://example.com/page"> to the <head>.';
  if (href === '') return makeResult(CANONICAL, 'fail', 'Missing canonical URL', remediation);
  let absolute = false;
  try {
    const protocol = new URL(href).protocol;
    absolute = protocol === 'http:' || protocol === 'https:';
  } catch {
    // Not parseable without a base, so it is relative.
  }
  if (!absolute) {
    return makeResult(
      CANONICAL,
      'warn',
      `Canonical URL is not absolute (${quoteUntrusted(href)})`,
      'Use an absolute URL including scheme and host in the canonical link.',
    );
  }
  return makeResult(CANONICAL, 'pass', `Canonical URL is ${quoteUntrusted(href)}`);
}

function looksLikeHtml(response: TextResponse): boolean {
  if (response.contentType?.toLowerCase().includes('text/html')) return true;
  return /^\s*<(!doctype|html)/i.test(response.body);
}

export function checkRobotsTxt(response: TextResponse): CheckResult {
  const remediation = 'Add a robots.txt at the site root, e.g. "User-agent: *" and a Sitemap line.';
  if (response.status === null) {
    return makeResult(ROBOTS, 'fail', 'robots.txt could not be fetched', remediation);
  }
  if (response.status !== 200) {
    return makeResult(ROBOTS, 'fail', `robots.txt returned HTTP ${response.status}`, remediation);
  }
  if (looksLikeHtml(response)) {
    return makeResult(ROBOTS, 'fail', 'robots.txt returned an HTML page', remediation);
  }
  return makeResult(ROBOTS, 'pass', 'robots.txt found');
}

/** Extracts absolute http(s) URLs from `Sitemap:` lines in a robots.txt. */
export function extractSitemapUrls(robotsTxt: string): string[] {
  const urls: string[] = [];
  for (const line of robotsTxt.split(/\r?\n/)) {
    const match = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
    if (!match?.[1]) continue;
    try {
      const url = new URL(match[1]);
      if (url.protocol === 'http:' || url.protocol === 'https:') urls.push(url.href);
    } catch {
      // Ignore malformed entries.
    }
  }
  return urls;
}

/** The first sitemap listed in a valid robots.txt, otherwise /sitemap.xml on the site. */
export function resolveSitemapUrl(pageUrl: string, robots: TextResponse): string {
  if (robots.status === 200 && !looksLikeHtml(robots)) {
    const [first] = extractSitemapUrls(robots.body);
    if (first) return first;
  }
  return new URL('/sitemap.xml', pageUrl).href;
}

/**
 * A gzipped file such as sitemap.xml.gz. fetch only decompresses Content-Encoding, not a file
 * that is itself gzip, so its body cannot be inspected as text.
 */
function isGzipFile(response: TextResponse): boolean {
  if (/^application\/(x-)?gzip\b/i.test(response.contentType ?? '')) return true;
  return new URL(response.url).pathname.toLowerCase().endsWith('.gz');
}

export function checkSitemap(response: TextResponse): CheckResult {
  const remediation =
    'Publish an XML sitemap (e.g. /sitemap.xml) and reference it with "Sitemap: <url>" in robots.txt.';
  if (response.status === null) {
    return makeResult(SITEMAP, 'fail', 'Sitemap could not be fetched', remediation);
  }
  if (response.status !== 200) {
    return makeResult(SITEMAP, 'fail', `Sitemap returned HTTP ${response.status}`, remediation);
  }
  if (isGzipFile(response)) {
    return makeResult(
      SITEMAP,
      'pass',
      `Compressed sitemap found at ${response.url} (contents not inspected)`,
    );
  }
  if (!/<(urlset|sitemapindex)[\s>]/i.test(response.body)) {
    return makeResult(
      SITEMAP,
      'warn',
      'Sitemap URL responds but does not contain an XML sitemap',
      remediation,
    );
  }
  return makeResult(SITEMAP, 'pass', `Sitemap found at ${response.url}`);
}

export interface SeoInput extends PageInput {
  robots: TextResponse;
  sitemap: TextResponse;
}

export function runSeoChecks(input: SeoInput): CheckResult[] {
  const { robots, sitemap } = input;
  return [
    safeRunPage(TITLE, input, checkTitle),
    safeRunPage(META_DESCRIPTION, input, checkMetaDescription),
    safeRunPage(H1, input, checkH1),
    safeRunPage(CANONICAL, input, checkCanonical),
    safeRun(ROBOTS, () => checkRobotsTxt(robots)),
    safeRun(SITEMAP, () => checkSitemap(sitemap)),
  ];
}
