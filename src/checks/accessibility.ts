import type { CheerioAPI } from 'cheerio';
import { quoteUntrusted } from '../text.js';
import { makeResult, safeRunPage, type PageInput } from './run.js';
import type { CheckDefinition, CheckResult } from './types.js';

/** Up to this share of elements may lack a name or label before the check fails instead of warns. */
export const WARN_RATIO = 0.2;
/** A `maximum-scale` below this stops users from zooming to 200 % (WCAG 1.4.4). */
export const MIN_MAXIMUM_SCALE = 2;
/** WCAG 2.2.1 exempts time limits longer than 20 hours, so slower refreshes are allowed. */
export const MAX_REFRESH_DELAY_S = 20 * 60 * 60;

const def = (id: string, maxPoints: number, wcag: string[]): CheckDefinition => ({
  id,
  category: 'accessibility',
  maxPoints,
  wcag,
});

const LANG = def('html-lang', 5, ['3.1.1']);
const IMAGE_ALT = def('image-alt', 6, ['1.1.1']);
const HEADINGS = def('heading-structure', 4, ['1.3.1']);
const LINK_NAME = def('link-name', 4, ['2.4.4', '4.1.2']);
const BUTTON_NAME = def('button-name', 3, ['4.1.2']);
const FORM_LABEL = def('form-label', 5, ['1.3.1', '3.3.2']);
const IFRAME_TITLE = def('iframe-title', 2, ['4.1.2']);
const LANDMARKS = def('landmarks', 3, ['1.3.1', '2.4.1']);
const ARIA_VALID = def('aria-valid', 4, ['4.1.2']);
const ZOOM = def('zoom-allowed', 2, ['1.4.4']);
const TABINDEX = def('tabindex', 1, ['2.4.3']);
const META_REFRESH = def('meta-refresh', 1, ['2.2.1']);
const TABLE_HEADERS = def('table-headers', 2, ['1.3.1']);
const AUTOCOMPLETE = def('autocomplete', 2, ['1.3.5']);
const MEDIA_AUTOPLAY = def('media-autoplay', 1, ['1.4.2']);

/** Non-abstract WAI-ARIA 1.2 roles. */
const ARIA_ROLES = new Set(
  (
    'alert alertdialog application article banner blockquote button caption cell checkbox code ' +
    'columnheader combobox complementary contentinfo definition deletion dialog directory document ' +
    'emphasis feed figure form generic grid gridcell group heading img insertion link list listbox ' +
    'listitem log main marquee math meter menu menubar menuitem menuitemcheckbox menuitemradio ' +
    'navigation none note option paragraph presentation progressbar radio radiogroup region row ' +
    'rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong ' +
    'subscript superscript switch tab table tablist tabpanel term textbox time timer toolbar ' +
    'tooltip tree treegrid treeitem ' +
    // Graphics-ARIA 1.0
    'graphics-document graphics-object graphics-symbol ' +
    // DPUB-ARIA 1.1, including the deprecated doc-biblioentry and doc-endnote
    'doc-abstract doc-acknowledgments doc-afterword doc-appendix doc-backlink doc-biblioentry ' +
    'doc-bibliography doc-biblioref doc-chapter doc-colophon doc-conclusion doc-cover doc-credit ' +
    'doc-credits doc-dedication doc-endnote doc-endnotes doc-epigraph doc-epilogue doc-errata ' +
    'doc-example doc-footnote doc-foreword doc-glossary doc-glossref doc-index doc-introduction ' +
    'doc-noteref doc-notice doc-pagebreak doc-pagefooter doc-pageheader doc-pagelist doc-part ' +
    'doc-preface doc-prologue doc-pullquote doc-qna doc-subtitle doc-tip doc-toc'
  ).split(' '),
);

const FOCUSABLE =
  'a[href], area[href], button, input:not([type="hidden" i]), select, textarea, summary, [tabindex]';
const ARIA_HIDDEN = '[aria-hidden="true" i]';

type Selection = ReturnType<CheerioAPI>;

/** True if the element or an ancestor is hidden from assistive technology. */
function isAriaHidden(el: Selection): boolean {
  return el.closest(ARIA_HIDDEN).length > 0;
}

const idIndexes = new WeakMap<CheerioAPI, Map<string, Selection>>();

/** First element per id, built once per document so id lookups stay linear on large pages. */
function elementsById($: CheerioAPI): Map<string, Selection> {
  let index = idIndexes.get($);
  if (index === undefined) {
    index = new Map();
    for (const node of $('[id]').toArray()) {
      const id = $(node).attr('id') ?? '';
      if (!index.has(id)) index.set(id, $(node));
    }
    idIndexes.set($, index);
  }
  return index;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Whitespace-separated id references (aria-labelledby and friends). */
function idRefs(value: string | undefined): string[] {
  return (value ?? '').split(/\s+/).filter((id) => id !== '');
}

/** Shared pass/warn/fail for checks of the form "N of M elements have a problem". */
function ratioResult(
  checkDef: CheckDefinition,
  total: number,
  bad: number,
  noun: string,
  passVerb: string,
  failVerb: string,
  remediation: string,
): CheckResult {
  if (total === 0) return makeResult(checkDef, 'pass', `No ${noun} to check`);
  if (bad === 0) return makeResult(checkDef, 'pass', `All ${total} ${noun} ${passVerb}`);
  return makeResult(
    checkDef,
    bad / total <= WARN_RATIO ? 'warn' : 'fail',
    `${bad} of ${total} ${noun} ${failVerb}`,
    remediation,
  );
}

/**
 * Name from an element's content: text, image alts and descendants' aria-labels (which also
 * covers SVG titles). Content hidden with aria-hidden is not part of the name.
 */
function contentText($: CheerioAPI, el: Selection): string {
  let text = '';
  for (const node of el.contents().toArray()) {
    if (node.nodeType === 3) {
      text += $(node).text();
      continue;
    }
    if (node.nodeType !== 1) continue;
    const child = $(node);
    if (child.is(`${ARIA_HIDDEN}, script, style, template`)) continue;
    const label = normalizeText(child.attr('aria-label') ?? '');
    if (label !== '') text += ` ${label} `;
    else if (child.is('img')) text += ` ${child.attr('alt') ?? ''} `;
    else text += ` ${contentText($, child)} `;
  }
  return text;
}

/** True if an aria-labelledby reference list points at an element with a name. */
function labelledByName($: CheerioAPI, value: string | undefined): boolean {
  const index = elementsById($);
  return idRefs(value).some((id) => {
    const target = index.get(id);
    if (target === undefined) return false;
    return (
      normalizeText(target.attr('aria-label') ?? '') !== '' ||
      normalizeText(contentText($, target)) !== ''
    );
  });
}

/** Accessible name from the attributes every element can use. */
function hasAttributeName($: CheerioAPI, el: Selection): boolean {
  return (
    normalizeText(el.attr('aria-label') ?? '') !== '' ||
    labelledByName($, el.attr('aria-labelledby')) ||
    normalizeText(el.attr('title') ?? '') !== ''
  );
}

/** Name of a link or button: its content or the shared attributes. */
function hasContentName($: CheerioAPI, el: Selection): boolean {
  return normalizeText(contentText($, el)) !== '' || hasAttributeName($, el);
}

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
    missing / total <= WARN_RATIO ? 'warn' : 'fail',
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

export function checkLinkName($: CheerioAPI): CheckResult {
  // A link with role=button is exposed as a button and checked by button-name instead.
  const links = $('a[href]')
    .not('[role="button" i]')
    .filter((_, el) => !isAriaHidden($(el)));
  const bad = links.filter((_, el) => !hasContentName($, $(el))).length;
  return ratioResult(
    LINK_NAME,
    links.length,
    bad,
    'links',
    'have an accessible name',
    'have no accessible name',
    'Give every link descriptive text, an aria-label, or an image with alt text.',
  );
}

export function checkButtonName($: CheerioAPI): CheckResult {
  const buttons = $(
    'button, [role="button" i], input[type="button" i], input[type="submit" i], input[type="reset" i], input[type="image" i]',
  ).filter((_, el) => $(el).attr('role')?.toLowerCase() !== 'presentation' && !isAriaHidden($(el)));
  const bad = buttons.filter((_, node) => {
    const el = $(node);
    if (el.is('input')) {
      const type = (el.attr('type') ?? '').toLowerCase();
      // submit and reset have a built-in name even without a value.
      if (type === 'submit' || type === 'reset') return false;
      if (type === 'image') {
        return normalizeText(el.attr('alt') ?? '') === '' && !hasAttributeName($, el);
      }
      return normalizeText(el.attr('value') ?? '') === '' && !hasAttributeName($, el);
    }
    return !hasContentName($, el);
  }).length;
  return ratioResult(
    BUTTON_NAME,
    buttons.length,
    bad,
    'buttons',
    'have an accessible name',
    'have no accessible name',
    'Give every button visible text or an aria-label, e.g. <button aria-label="Close">×</button>.',
  );
}

const UNLABELLED_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

export function checkFormLabel($: CheerioAPI): CheckResult {
  const labelTargets = new Set(
    $('label[for]')
      .map((_, el) => $(el).attr('for') ?? '')
      .get(),
  );
  const fields = $('input, select, textarea').filter((_, el) => {
    const type = ($(el).attr('type') ?? 'text').toLowerCase();
    return !($(el).is('input') && UNLABELLED_INPUT_TYPES.has(type));
  });
  const bad = fields.filter((_, node) => {
    const el = $(node);
    const id = el.attr('id');
    if (id !== undefined && id !== '' && labelTargets.has(id)) return false;
    if (el.closest('label').length > 0) return false;
    return !hasAttributeName($, el);
  }).length;
  return ratioResult(
    FORM_LABEL,
    fields.length,
    bad,
    'form fields',
    'have a label',
    'have no label',
    'Associate each field with a <label for="id">, wrap it in a <label>, or add an aria-label.',
  );
}

export function checkIframeTitle($: CheerioAPI): CheckResult {
  // Hidden frames (tracking pixels and the like) are not announced and need no title.
  const frames = $('iframe').filter((_, el) => !isAriaHidden($(el)));
  if (frames.length === 0) return makeResult(IFRAME_TITLE, 'pass', 'No iframes to check');
  const bad = frames.filter((_, el) => !hasAttributeName($, $(el))).length;
  if (bad === 0) {
    return makeResult(IFRAME_TITLE, 'pass', `All ${frames.length} iframes have a title`);
  }
  return makeResult(
    IFRAME_TITLE,
    'fail',
    `${bad} of ${frames.length} iframes have no title`,
    'Add a title attribute describing the content of each <iframe>.',
  );
}

export function checkLandmarks($: CheerioAPI): CheckResult {
  // HTML allows extra <main> elements as long as all but one are hidden.
  const count = $('main, [role="main" i]').filter(
    (_, el) => $(el).closest('[hidden]').length === 0,
  ).length;
  if (count === 1) return makeResult(LANDMARKS, 'pass', 'Page has one main landmark');
  if (count === 0) {
    return makeResult(
      LANDMARKS,
      'fail',
      'Page has no main landmark',
      'Wrap the primary content in a <main> element so assistive technology can jump to it.',
    );
  }
  return makeResult(
    LANDMARKS,
    'warn',
    `Page has ${count} main landmarks`,
    'Use exactly one <main> element per page.',
  );
}

export function checkAriaValid($: CheerioAPI): CheckResult {
  const ids = elementsById($);
  const problems: string[] = [];

  $('[role]').each((_, el) => {
    const role = ($(el).attr('role') ?? '').trim().toLowerCase();
    if (role === '') return;
    // A role list is a fallback chain; the first recognised token wins.
    if (!role.split(/\s+/).some((token) => ARIA_ROLES.has(token))) {
      problems.push(`invalid role "${quoteUntrusted(role, 40)}"`);
    }
  });

  for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls']) {
    $(`[${attr}]`).each((_, el) => {
      const node = $(el);
      // Collapsed widgets legitimately point at content that is not in the DOM yet.
      if (attr === 'aria-controls' && node.attr('aria-expanded') === 'false') return;
      const missing = idRefs(node.attr(attr)).filter((id) => !ids.has(id));
      for (const id of missing)
        problems.push(`${attr} points to missing id "${quoteUntrusted(id, 40)}"`);
    });
  }

  $(FOCUSABLE).each((_, el) => {
    const node = $(el);
    if (!isAriaHidden(node)) return;
    const tabindex = Number.parseInt(node.attr('tabindex') ?? '', 10);
    if (tabindex < 0 || node.is('[disabled]')) return;
    problems.push(
      `focusable <${node.prop('tagName')?.toString().toLowerCase()}> inside aria-hidden content`,
    );
  });

  if (problems.length === 0) return makeResult(ARIA_VALID, 'pass', 'ARIA usage is valid');
  const shown = problems.slice(0, 3).join('; ');
  const more = problems.length > 3 ? `; +${problems.length - 3} more` : '';
  return makeResult(
    ARIA_VALID,
    'fail',
    `${problems.length} ${problems.length === 1 ? 'ARIA problem' : 'ARIA problems'}: ${shown}${more}`,
    'Use valid role values, point aria-* references at existing ids, and never hide focusable elements with aria-hidden.',
  );
}

export function checkZoomAllowed($: CheerioAPI): CheckResult {
  const content = $('meta[name="viewport" i]').first().attr('content') ?? '';
  const settings = new Map<string, string>();
  for (const part of content.split(/[,;]/)) {
    const [key, value] = part.split('=');
    if (key !== undefined && value !== undefined) {
      settings.set(key.trim().toLowerCase(), value.trim().toLowerCase());
    }
  }
  const scalable = settings.get('user-scalable');
  const maxScale = Number.parseFloat(settings.get('maximum-scale') ?? '');
  const remediation =
    'Remove user-scalable=no and maximum-scale from the viewport meta tag so users can zoom.';
  if (scalable === 'no' || scalable === '0') {
    return makeResult(ZOOM, 'fail', 'Viewport disables zooming (user-scalable=no)', remediation);
  }
  if (maxScale < MIN_MAXIMUM_SCALE) {
    return makeResult(
      ZOOM,
      'fail',
      `Viewport limits zooming (maximum-scale=${maxScale})`,
      remediation,
    );
  }
  return makeResult(ZOOM, 'pass', 'Viewport allows zooming');
}

export function checkTabindex($: CheerioAPI): CheckResult {
  const positive = $('[tabindex]').filter(
    (_, el) => Number.parseInt($(el).attr('tabindex') ?? '', 10) > 0,
  ).length;
  if (positive === 0) return makeResult(TABINDEX, 'pass', 'No positive tabindex values');
  return makeResult(
    TABINDEX,
    'fail',
    `${positive} ${positive === 1 ? 'element has' : 'elements have'} a positive tabindex`,
    'Use tabindex="0" or "-1" and order the elements in the DOM instead.',
  );
}

export function checkMetaRefresh($: CheerioAPI): CheckResult {
  const refreshes = $('meta[http-equiv="refresh" i]').filter((_, el) => {
    const delay = Number.parseFloat(
      /^\s*(\d+(?:\.\d+)?)/.exec($(el).attr('content') ?? '')?.[1] ?? '',
    );
    return delay > 0 && delay <= MAX_REFRESH_DELAY_S;
  }).length;
  if (refreshes === 0) return makeResult(META_REFRESH, 'pass', 'No delayed meta refresh');
  return makeResult(
    META_REFRESH,
    'fail',
    'Page redirects or reloads itself with a delayed meta refresh',
    'Remove <meta http-equiv="refresh"> or use a server-side redirect.',
  );
}

export function checkTableHeaders($: CheerioAPI): CheckResult {
  // Tables with role=presentation/none are layout tables and need no headers.
  const tables = $('table').filter((_, el) => {
    const role = $(el).attr('role')?.trim().toLowerCase();
    return role !== 'presentation' && role !== 'none' && !isAriaHidden($(el));
  });
  const bad = tables.filter((_, el) => $(el).find('th').length === 0).length;
  return ratioResult(
    TABLE_HEADERS,
    tables.length,
    bad,
    'tables',
    'have header cells',
    'have no header cells',
    'Mark header cells with <th> (and scope where needed), or add role="presentation" to layout tables.',
  );
}

/** Field names that collect personal data covered by WCAG 1.3.5. */
const PERSONAL_FIELD_NAME =
  /^(?:(?:first|last|given|family|full|user)[-_ ]?name|name|e-?mail|email[-_ ]?address|phone|tel|telephone|mobile|address|street|city|zip|postal[-_ ]?code|postcode|country|username|cc-?number|birthday|bday)$/i;
const PERSONAL_INPUT_TYPES = new Set(['email', 'tel']);

export function checkAutocomplete($: CheerioAPI): CheckResult {
  const fields = $('input').filter((_, node) => {
    const el = $(node);
    if (isAriaHidden(el) || el.is('[disabled]') || el.closest('[hidden]').length > 0) return false;
    const type = (el.attr('type') ?? 'text').toLowerCase();
    if (PERSONAL_INPUT_TYPES.has(type)) return true;
    if (type !== 'text' && type !== 'search') return false;
    return [el.attr('name'), el.attr('id')].some((v) => PERSONAL_FIELD_NAME.test((v ?? '').trim()));
  });
  // "on" and "off" do not identify the field's purpose, so they do not count.
  const bad = fields.filter((_, node) => {
    const value = ($(node).attr('autocomplete') ?? '').trim().toLowerCase();
    return value === '' || value === 'off' || value === 'on';
  }).length;
  return ratioResult(
    AUTOCOMPLETE,
    fields.length,
    bad,
    'personal data fields',
    'have an autocomplete token',
    'have no autocomplete token',
    'Add an autocomplete token such as autocomplete="email" or "given-name" to fields that collect personal data.',
  );
}

export function checkMediaAutoplay($: CheerioAPI): CheckResult {
  // controls gives the user a way to pause or stop the audio, which satisfies 1.4.2.
  const bad = $('video[autoplay], audio[autoplay]').filter(
    (_, el) => !$(el).is('[muted], [controls]'),
  ).length;
  if (bad === 0) {
    return makeResult(
      MEDIA_AUTOPLAY,
      'pass',
      'No media plays sound automatically without controls',
    );
  }
  return makeResult(
    MEDIA_AUTOPLAY,
    'fail',
    `${bad} ${bad === 1 ? 'media element plays' : 'media elements play'} sound automatically without controls`,
    'Remove autoplay, or add muted or controls so the sound can be stopped.',
  );
}

export function runAccessibilityChecks(page: PageInput): CheckResult[] {
  return [
    safeRunPage(LANG, page, checkHtmlLang),
    safeRunPage(IMAGE_ALT, page, checkImageAlt),
    safeRunPage(HEADINGS, page, checkHeadingStructure),
    safeRunPage(LINK_NAME, page, checkLinkName),
    safeRunPage(BUTTON_NAME, page, checkButtonName),
    safeRunPage(FORM_LABEL, page, checkFormLabel),
    safeRunPage(IFRAME_TITLE, page, checkIframeTitle),
    safeRunPage(LANDMARKS, page, checkLandmarks),
    safeRunPage(ARIA_VALID, page, checkAriaValid),
    safeRunPage(ZOOM, page, checkZoomAllowed),
    safeRunPage(TABINDEX, page, checkTabindex),
    safeRunPage(META_REFRESH, page, checkMetaRefresh),
    safeRunPage(TABLE_HEADERS, page, checkTableHeaders),
    safeRunPage(AUTOCOMPLETE, page, checkAutocomplete),
    safeRunPage(MEDIA_AUTOPLAY, page, checkMediaAutoplay),
  ];
}
