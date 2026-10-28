import type { CheerioAPI } from 'cheerio';
import { quoteUntrusted } from '../text.js';
import { makeResult, safeRunPage, type PageInput } from './run.js';
import type { CheckDefinition, CheckResult } from './types.js';

/** Up to this share of images may lack alt before the check fails instead of warns. */
export const IMAGE_ALT_WARN_RATIO = 0.2;

const def = (id: string, maxPoints: number): CheckDefinition => ({
  id,
  category: 'html',
  maxPoints,
});

const LANG = def('html-lang', 5);
const VIEWPORT = def('viewport-meta', 5);
const IMAGE_ALT = def('image-alt', 6);
const HEADINGS = def('heading-structure', 4);

export function checkHtmlLang($: CheerioAPI): CheckResult {
  const lang = ($('html').first().attr('lang') ?? '').trim();
  if (lang === '') {
    return makeResult(
      LANG,
      'fail',
      'Missing lang attribute on <html>',
      'Add a language, e.g. <html lang="en">, so browsers and screen readers pick the right language.',
    );
  }
  return makeResult(LANG, 'pass', `Document language is "${quoteUntrusted(lang)}"`);
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

export function checkImageAlt($: CheerioAPI): CheckResult {
  const images = $('img');
  const total = images.length;
  if (total === 0) return makeResult(IMAGE_ALT, 'pass', 'No images to check');
  // alt="" is valid (decorative image); only a missing attribute counts.
  const missing = images.filter((_, el) => $(el).attr('alt') === undefined).length;
  if (missing === 0)
    return makeResult(IMAGE_ALT, 'pass', `All ${total} images have alt attributes`);
  const message = `${missing} ${missing === 1 ? 'image is' : 'images are'} missing alt attributes (of ${total})`;
  const remediation =
    'Add a descriptive alt attribute to each image, or alt="" for purely decorative images.';
  return makeResult(
    IMAGE_ALT,
    missing / total <= IMAGE_ALT_WARN_RATIO ? 'warn' : 'fail',
    message,
    remediation,
  );
}

export function checkHeadingStructure($: CheerioAPI): CheckResult {
  const levels = $('h1, h2, h3, h4, h5, h6')
    .map((_, el) => Number($(el).prop('tagName')?.toString().slice(1)))
    .get();
  if (levels.length === 0) {
    return makeResult(
      HEADINGS,
      'fail',
      'Page has no headings',
      'Structure the content with headings, starting with an <h1>.',
    );
  }
  // Only skipped levels count here; a missing or misplaced <h1> is the h1 check's job.
  const remediation = 'Do not skip heading levels (e.g. <h2> followed by <h4>).';
  for (let i = 1; i < levels.length; i++) {
    const prev = levels[i - 1] as number;
    const level = levels[i] as number;
    if (level > prev + 1) {
      return makeResult(
        HEADINGS,
        'warn',
        `Heading level skips from <h${prev}> to <h${level}>`,
        remediation,
      );
    }
  }
  return makeResult(HEADINGS, 'pass', 'Heading levels are in order');
}

export function runHtmlChecks(page: PageInput): CheckResult[] {
  return [
    safeRunPage(LANG, page, checkHtmlLang),
    safeRunPage(VIEWPORT, page, checkViewport),
    safeRunPage(IMAGE_ALT, page, checkImageAlt),
    safeRunPage(HEADINGS, page, checkHeadingStructure),
  ];
}
