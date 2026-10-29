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
const VIEWPORT = def('viewport-meta', 5);
const ROBOTS = def('robots-txt', 3);
const SITEMAP = def('sitemap-xml', 3);
const INDEXABLE = def('indexable', 5);
const OPEN_GRAPH = def('open-graph', 2);
const STRUCTURED_DATA = def('structured-data', 2);
const HREFLANG = def('hreflang', 2);
const CHARSET = def('charset', 1);
const DOCTYPE = def('doctype', 1);
const DUPLICATE_TITLES = def('duplicate-titles', 2);
const DUPLICATE_DESCRIPTIONS = def('duplicate-descriptions', 1);

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

/** The page's title, as `checkTitle` reads it; empty if there is none. */
export function pageTitle($: CheerioAPI): string {
  // <title> inside inline SVG labels the icon, not the page.
  const element = $('title')
    .filter((_, el) => $(el).closest('svg').length === 0)
    .first();
  return normalizeText(element.text());
}

export function pageDescription($: CheerioAPI): string {
  return normalizeText($('meta[name="description" i]').first().attr('content') ?? '');
}

/**
 * Site-wide: do analysed pages share a title or description? `values` has one entry per analysed
 * page, empty where the page has none (those pages are left out; `title`/`meta-description` cover them).
 */
function duplicateResult(checkDef: CheckDefinition, label: string, values: string[]): CheckResult {
  const present = values.filter((v) => v !== '');
  if (values.length < 2) {
    return makeResult(checkDef, 'skip', `Skipped ${checkDef.id}: needs --pages 2 or more`);
  }
  if (present.length < 2) {
    return makeResult(
      checkDef,
      'skip',
      `Skipped ${checkDef.id}: fewer than two pages have a ${label}`,
    );
  }
  const counts = new Map<string, number>();
  for (const v of present) counts.set(v, (counts.get(v) ?? 0) + 1);
  const duplicated = [...counts.entries()].filter(([, n]) => n > 1);
  if (duplicated.length === 0) {
    return makeResult(checkDef, 'pass', `All ${present.length} pages have a unique ${label}`);
  }
  const sharing = duplicated.reduce((sum, [, n]) => sum + n, 0);
  const status = sharing / present.length > 0.2 ? 'fail' : 'warn';
  return makeResult(
    checkDef,
    status,
    `${sharing} of ${present.length} pages share a ${label}, e.g. ${quoteUntrusted(duplicated[0]![0])}`,
    `Give every page its own ${label} that describes that page.`,
  );
}

export function checkDuplicateTitles(titles: string[]): CheckResult {
  return duplicateResult(DUPLICATE_TITLES, 'title', titles);
}

export function checkDuplicateDescriptions(descriptions: string[]): CheckResult {
  return duplicateResult(DUPLICATE_DESCRIPTIONS, 'meta description', descriptions);
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

export function checkCanonical($: CheerioAPI, finalUrl?: string): CheckResult {
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
  if (finalUrl !== undefined && new URL(href).origin !== new URL(finalUrl).origin) {
    return makeResult(
      CANONICAL,
      'warn',
      `Canonical URL points to another origin (${quoteUntrusted(href)})`,
      'Point the canonical link at a URL on this site, unless the content really is published elsewhere first.',
    );
  }
  return makeResult(CANONICAL, 'pass', `Canonical URL is ${quoteUntrusted(href)}`);
}

export function checkViewport($: CheerioAPI): CheckResult {
  const content = $('meta[name="viewport" i]').first().attr('content');
  const remediation =
    'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the <head>.';
  if (content === undefined) {
    return makeResult(VIEWPORT, 'fail', 'Missing viewport meta tag', remediation);
  }
  if (!/width\s*=\s*device-width/i.test(content)) {
    return makeResult(
      VIEWPORT,
      'warn',
      `Viewport meta tag lacks width=device-width (${quoteUntrusted(content)})`,
      remediation,
    );
  }
  return makeResult(VIEWPORT, 'pass', 'Viewport meta tag is set');
}

/**
 * Robots directives of an `X-Robots-Tag` header that apply to all crawlers. `fetch` joins repeated
 * headers with ", ", so a token like "googlebot: noindex" opens a scope for a specific crawler
 * that lasts until the next prefixed token; those directives are ignored.
 */
function headerRobotsDirectives(value: string | undefined): string[] {
  const directives: string[] = [];
  let forAll = true;
  for (const token of (value ?? '').split(',')) {
    let directive = token.trim().toLowerCase();
    const prefixed = /^([a-z0-9_-]+)\s*:\s*(.*)$/.exec(directive);
    if (prefixed && prefixed[1] !== 'unavailable_after') {
      forAll = prefixed[1] === 'all' || prefixed[1] === '*';
      directive = prefixed[2] ?? '';
    }
    if (forAll && directive !== '') directives.push(directive);
  }
  return directives;
}

export function checkIndexable($: CheerioAPI, headers: Record<string, string> = {}): CheckResult {
  const metaDirectives = ($('meta[name="robots" i]').attr('content') ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase());
  const header = headerRobotsDirectives(headers['x-robots-tag']);
  const has = (...names: string[]) =>
    [...metaDirectives, ...header].some((directive) => names.includes(directive));
  const remediation =
    'Remove "noindex" from <meta name="robots"> and the X-Robots-Tag header so search engines can index the page.';
  if (has('noindex', 'none')) {
    return makeResult(
      INDEXABLE,
      'fail',
      'Page tells search engines not to index it (noindex)',
      remediation,
    );
  }
  if (has('nofollow')) {
    return makeResult(
      INDEXABLE,
      'warn',
      'Page tells search engines not to follow its links (nofollow)',
      'Remove "nofollow" from <meta name="robots"> unless you really want links on the page ignored.',
    );
  }
  return makeResult(INDEXABLE, 'pass', 'Page can be indexed by search engines');
}

export function checkOpenGraph($: CheerioAPI): CheckResult {
  const missing = ['og:title', 'og:description', 'og:image'].filter(
    (property) => ($(`meta[property="${property}" i]`).attr('content') ?? '').trim() === '',
  );
  if (missing.length === 0) return makeResult(OPEN_GRAPH, 'pass', 'Open Graph tags are set');
  const remediation = `Add <meta property="..." content="..."> for ${missing.join(', ')} so links to the page get a proper preview.`;
  if (missing.length === 3) {
    return makeResult(OPEN_GRAPH, 'fail', 'No Open Graph tags', remediation);
  }
  return makeResult(
    OPEN_GRAPH,
    'warn',
    `Missing Open Graph tags: ${missing.join(', ')}`,
    remediation,
  );
}

export function checkStructuredData($: CheerioAPI): CheckResult {
  const blocks = $('script[type="application/ld+json" i]').toArray();
  let invalid = 0;
  for (const block of blocks) {
    try {
      const data: unknown = JSON.parse($(block).text());
      const items = Array.isArray(data) ? data : [data];
      const valid = items.every((item) => {
        if (typeof item !== 'object' || item === null) return false;
        const node = item as Record<string, unknown>;
        // A @graph document carries @context once at the top and @type on its nodes.
        return '@type' in node || Array.isArray(node['@graph']);
      });
      if (!valid) invalid++;
    } catch {
      invalid++;
    }
  }
  if (invalid === 0) {
    return makeResult(
      STRUCTURED_DATA,
      'pass',
      blocks.length === 0 ? 'No structured data' : `${blocks.length} valid JSON-LD block(s)`,
    );
  }
  return makeResult(
    STRUCTURED_DATA,
    'fail',
    `${invalid} of ${blocks.length} JSON-LD blocks are invalid (not JSON or missing @type)`,
    'Fix the JSON syntax and give each JSON-LD object an @context and @type; validate at validator.schema.org.',
  );
}

const LANGUAGE_TAG = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

export function checkHreflang($: CheerioAPI): CheckResult {
  const bad: string[] = [];
  $('link[rel~="alternate" i][hreflang]').each((_, el) => {
    const lang = ($(el).attr('hreflang') ?? '').trim();
    const href = ($(el).attr('href') ?? '').trim();
    let absolute = false;
    try {
      const protocol = new URL(href).protocol;
      absolute = protocol === 'http:' || protocol === 'https:';
    } catch {
      // Relative or empty.
    }
    if (!absolute || (lang.toLowerCase() !== 'x-default' && !LANGUAGE_TAG.test(lang))) {
      bad.push(lang);
    }
  });
  if (bad.length === 0) return makeResult(HREFLANG, 'pass', 'hreflang annotations are valid');
  return makeResult(
    HREFLANG,
    'fail',
    `Invalid hreflang annotation(s): ${bad.map((b) => quoteUntrusted(b)).join(', ')}`,
    'Use language tags such as "en" or "sv-SE" (or "x-default") with an absolute href.',
  );
}

export function checkCharset($: CheerioAPI, headers: Record<string, string> = {}): CheckResult {
  const fromHeader = /charset\s*=/i.test(headers['content-type'] ?? '');
  const fromMeta =
    $('meta[charset]').length > 0 ||
    $('meta[http-equiv="content-type" i]').filter((_, el) =>
      /charset/i.test($(el).attr('content') ?? ''),
    ).length > 0;
  if (fromHeader || fromMeta) return makeResult(CHARSET, 'pass', 'Character encoding is declared');
  return makeResult(
    CHARSET,
    'fail',
    'No character encoding declared',
    'Add <meta charset="utf-8"> early in the <head> (within the first 1024 bytes).',
  );
}

export function checkDoctype($: CheerioAPI): CheckResult {
  const node = $.root()
    .contents()
    .toArray()
    .find((n) => n.type === 'directive');
  const data = node && 'data' in node ? String(node.data).trim() : '';
  if (/^!doctype\s+html\s*$/i.test(data)) {
    return makeResult(DOCTYPE, 'pass', 'Document has the HTML5 doctype');
  }
  const remediation = 'Start the document with <!DOCTYPE html> to avoid quirks mode.';
  if (data === '') return makeResult(DOCTYPE, 'fail', 'Missing doctype (quirks mode)', remediation);
  return makeResult(DOCTYPE, 'warn', `Non-standard doctype (${quoteUntrusted(data)})`, remediation);
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

/** Checks that apply to every analysed page. */
export function runSeoPageChecks(
  page: PageInput & { headers?: Record<string, string>; finalUrl?: string },
): CheckResult[] {
  return [
    safeRunPage(TITLE, page, checkTitle),
    safeRunPage(META_DESCRIPTION, page, checkMetaDescription),
    safeRunPage(H1, page, checkH1),
    safeRunPage(CANONICAL, page, ($) => checkCanonical($, page.finalUrl)),
    safeRunPage(VIEWPORT, page, checkViewport),
    safeRunPage(INDEXABLE, page, ($) => checkIndexable($, page.headers)),
    safeRunPage(OPEN_GRAPH, page, checkOpenGraph),
    safeRunPage(STRUCTURED_DATA, page, checkStructuredData),
    safeRunPage(HREFLANG, page, checkHreflang),
    safeRunPage(CHARSET, page, ($) => checkCharset($, page.headers)),
    safeRunPage(DOCTYPE, page, checkDoctype),
  ];
}

/** Checks of the site as a whole, run once. */
export function runSeoSiteChecks(input: Pick<SeoInput, 'robots' | 'sitemap'>): CheckResult[] {
  return [
    safeRun(ROBOTS, () => checkRobotsTxt(input.robots)),
    safeRun(SITEMAP, () => checkSitemap(input.sitemap)),
  ];
}

/** Checks that compare the analysed pages with each other; `pages` has one entry per analysed page. */
export function runSeoCrossPageChecks(
  pages: { title: string; description: string }[],
): CheckResult[] {
  return [
    safeRun(DUPLICATE_TITLES, () => checkDuplicateTitles(pages.map((p) => p.title))),
    safeRun(DUPLICATE_DESCRIPTIONS, () =>
      checkDuplicateDescriptions(pages.map((p) => p.description)),
    ),
  ];
}

export function runSeoChecks(input: SeoInput): CheckResult[] {
  return [...runSeoPageChecks(input), ...runSeoSiteChecks(input)];
}
