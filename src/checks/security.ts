import { quoteUntrusted } from '../text.js';
import type { CheerioAPI } from 'cheerio';
import { makeResult, safeRun, safeRunPage, type PageInput } from './run.js';
import type { CheckDefinition, CheckResult, FetchedPage, TlsProbe } from './types.js';

/** Fewer days left than this on the certificate is a warning. */
export const TLS_WARN_DAYS = 30;
/** Fewer days left than this (or an expired certificate) fails. */
export const TLS_FAIL_DAYS = 7;
const MS_PER_DAY = 86_400_000;

/** 6 months, the commonly recommended minimum for HSTS. */
export const HSTS_MIN_MAX_AGE_SECONDS = 15_552_000;

const UNSAFE_CSP_KEYWORDS = ["'unsafe-inline'", "'unsafe-eval'"];
/** A nonce or hash makes browsers ignore 'unsafe-inline' (CSP Level 2+). */
const CSP_NONCE_OR_HASH = /^'(nonce-|sha256-|sha384-|sha512-)/;
const REFERRER_POLICIES = new Set([
  'no-referrer',
  'no-referrer-when-downgrade',
  'origin',
  'origin-when-cross-origin',
  'same-origin',
  'strict-origin',
  'strict-origin-when-cross-origin',
  'unsafe-url',
]);
const WEAK_REFERRER_POLICIES = new Set(['unsafe-url', 'no-referrer-when-downgrade']);

type Headers = Record<string, string>;
type SecurityInput = Pick<FetchedPage, 'headers' | 'finalUrl'>;

const def = (id: string, maxPoints: number): CheckDefinition => ({
  id,
  category: 'security',
  maxPoints,
});

const HTTPS = def('https', 10);
const HSTS = def('strict-transport-security', 8);
const CSP = def('content-security-policy', 8);
const NOSNIFF = def('x-content-type-options', 5);
const REFERRER = def('referrer-policy', 5);
const PERMISSIONS = def('permissions-policy', 4);
const TLS_CERTIFICATE = def('tls-certificate', 8);
const CLICKJACKING = def('clickjacking', 5);
const COOKIE_FLAGS = def('cookie-flags', 4);
const MIXED_CONTENT = def('mixed-content', 5);

/** Returns the trimmed header value, or undefined if missing or blank. */
function header(headers: Headers, name: string): string | undefined {
  const value = headers[name]?.trim();
  return value ? value : undefined;
}

function splitDirective(part: string): [name: string, value: string] {
  const eq = part.indexOf('=');
  if (eq === -1) return [part.trim().toLowerCase(), ''];
  const value = part
    .slice(eq + 1)
    .trim()
    .replace(/^"(.*)"$/, '$1');
  return [part.slice(0, eq).trim().toLowerCase(), value];
}

export interface HstsPolicy {
  /** null if max-age is missing or not a non-negative integer. */
  maxAge: number | null;
  includeSubDomains: boolean;
  preload: boolean;
}

export function parseHsts(value: string): HstsPolicy {
  const policy: HstsPolicy = { maxAge: null, includeSubDomains: false, preload: false };
  let seenMaxAge = false;
  // fetch joins repeated headers with ", "; browsers only use the first one.
  const first = value.split(',')[0] ?? '';
  for (const part of first.split(';')) {
    const [name, v] = splitDirective(part);
    if (name === 'max-age' && !seenMaxAge) {
      seenMaxAge = true;
      policy.maxAge = /^\d+$/.test(v) ? Number(v) : null;
    } else if (name === 'includesubdomains') {
      policy.includeSubDomains = true;
    } else if (name === 'preload') {
      policy.preload = true;
    }
  }
  return policy;
}

/** Parses a CSP header into directive name (lowercase) → source list. First occurrence wins. */
export function parseCsp(value: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of value.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (!name) continue;
    const key = name.toLowerCase();
    if (!directives.has(key)) directives.set(key, sources);
  }
  return directives;
}

/** Splits a header that may hold several policies (fetch joins repeated headers with ", "). */
export function parseCspPolicies(value: string): Map<string, string[]>[] {
  return value
    .split(',')
    .map(parseCsp)
    .filter((policy) => policy.size > 0);
}

/** The unsafe keywords a single policy actually allows for scripts, or null if it does not restrict scripts. */
function unsafeScriptKeywords(
  policy: Map<string, string[]>,
): { directive: string; keywords: string[] } | null {
  // script-src overrides default-src for scripts, so only the effective directive counts.
  const directive = policy.has('script-src') ? 'script-src' : 'default-src';
  const sources = policy.get(directive)?.map((s) => s.toLowerCase());
  if (sources === undefined) return null;
  const ignoresInline = sources.some((s) => CSP_NONCE_OR_HASH.test(s));
  const keywords = UNSAFE_CSP_KEYWORDS.filter(
    (keyword) => sources.includes(keyword) && !(keyword === "'unsafe-inline'" && ignoresInline),
  );
  return { directive, keywords };
}

export function checkHttps(finalUrl: string): CheckResult {
  if (new URL(finalUrl).protocol === 'https:') {
    return makeResult(HTTPS, 'pass', 'Page is served over HTTPS');
  }
  return makeResult(
    HTTPS,
    'fail',
    'Page is served over plain HTTP',
    "Install a TLS certificate and serve the site over HTTPS (e.g. a free certificate from Let's Encrypt).",
  );
}

export function checkHsts(headers: Headers, finalUrl: string): CheckResult {
  const remediation = `Add header: Strict-Transport-Security: max-age=${HSTS_MIN_MAX_AGE_SECONDS}; includeSubDomains`;
  const value = header(headers, 'strict-transport-security');
  if (new URL(finalUrl).protocol !== 'https:') {
    return makeResult(
      HSTS,
      'fail',
      'HSTS has no effect because the page was served over HTTP',
      `Serve the site over HTTPS, then add header: Strict-Transport-Security: max-age=${HSTS_MIN_MAX_AGE_SECONDS}`,
    );
  }
  if (value === undefined) {
    return makeResult(HSTS, 'fail', 'Missing Strict-Transport-Security header', remediation);
  }
  const { maxAge } = parseHsts(value);
  if (maxAge === null || maxAge === 0) {
    return makeResult(
      HSTS,
      'fail',
      `Strict-Transport-Security has no valid max-age (${quoteUntrusted(value)})`,
      remediation,
    );
  }
  if (maxAge < HSTS_MIN_MAX_AGE_SECONDS) {
    return makeResult(
      HSTS,
      'warn',
      `HSTS max-age is ${maxAge} seconds, below the recommended ${HSTS_MIN_MAX_AGE_SECONDS}`,
      remediation,
    );
  }
  return makeResult(HSTS, 'pass', `HSTS is enabled (max-age=${maxAge})`);
}

export function checkCsp(headers: Headers): CheckResult {
  const remediation =
    "Add header: Content-Security-Policy: default-src 'self' (and avoid 'unsafe-inline' and 'unsafe-eval')";
  const value = header(headers, 'content-security-policy');
  if (value === undefined) {
    return makeResult(CSP, 'fail', 'Missing Content-Security-Policy header', remediation);
  }
  const restricting = parseCspPolicies(value)
    .map(unsafeScriptKeywords)
    .filter((r) => r !== null);
  if (restricting.length === 0) {
    return makeResult(
      CSP,
      'warn',
      'Content-Security-Policy does not restrict scripts (no default-src or script-src)',
      "Add default-src or script-src to the policy, e.g. default-src 'self'",
    );
  }
  // Every policy is enforced, so a keyword is only allowed if all script-restricting policies allow it.
  const unsafe = UNSAFE_CSP_KEYWORDS.filter((keyword) =>
    restricting.every((r) => r.keywords.includes(keyword)),
  );
  const directiveName = restricting[0]?.directive ?? 'default-src';
  if (unsafe.length > 0) {
    return makeResult(
      CSP,
      'warn',
      `Content-Security-Policy allows ${unsafe.join(' and ')} in ${directiveName}`,
      `Remove ${unsafe.join(' and ')} from ${directiveName}; use nonces or hashes for inline scripts.`,
    );
  }
  return makeResult(CSP, 'pass', 'Content-Security-Policy is set');
}

export function checkContentTypeOptions(headers: Headers): CheckResult {
  const value = header(headers, 'x-content-type-options');
  const tokens = value?.split(',').map((t) => t.trim().toLowerCase()) ?? [];
  if (tokens.includes('nosniff')) {
    return makeResult(NOSNIFF, 'pass', 'X-Content-Type-Options is nosniff');
  }
  return makeResult(
    NOSNIFF,
    'fail',
    value === undefined
      ? 'Missing X-Content-Type-Options header'
      : `X-Content-Type-Options has unexpected value "${quoteUntrusted(value)}"`,
    'Add header: X-Content-Type-Options: nosniff',
  );
}

export function checkReferrerPolicy(headers: Headers): CheckResult {
  const remediation = 'Add header: Referrer-Policy: strict-origin-when-cross-origin';
  const value = header(headers, 'referrer-policy');
  if (value === undefined) {
    return makeResult(REFERRER, 'fail', 'Missing Referrer-Policy header', remediation);
  }
  // Browsers use the last token they recognise and ignore the rest.
  const effective = value
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t) => REFERRER_POLICIES.has(t))
    .at(-1);
  if (effective === undefined) {
    return makeResult(
      REFERRER,
      'fail',
      `Referrer-Policy has no valid value ("${quoteUntrusted(value)}")`,
      remediation,
    );
  }
  if (WEAK_REFERRER_POLICIES.has(effective)) {
    return makeResult(
      REFERRER,
      'warn',
      `Referrer-Policy "${effective}" can leak full URLs`,
      remediation,
    );
  }
  return makeResult(REFERRER, 'pass', `Referrer-Policy is ${effective}`);
}

export function checkPermissionsPolicy(headers: Headers): CheckResult {
  const remediation = 'Add header: Permissions-Policy: camera=(), microphone=(), geolocation=()';
  if (header(headers, 'permissions-policy') !== undefined) {
    return makeResult(PERMISSIONS, 'pass', 'Permissions-Policy is set');
  }
  if (header(headers, 'feature-policy') !== undefined) {
    return makeResult(
      PERMISSIONS,
      'warn',
      'Only the deprecated Feature-Policy header is set',
      `Replace Feature-Policy with Permissions-Policy. ${remediation}`,
    );
  }
  return makeResult(PERMISSIONS, 'fail', 'Missing Permissions-Policy header', remediation);
}

export function checkTlsCertificate(
  probe: TlsProbe | null,
  finalUrl: string,
  now: Date = new Date(),
): CheckResult {
  const remediation =
    "Renew or install a valid certificate for the host (e.g. from Let's Encrypt, with automatic renewal) and disable TLS versions below 1.2.";
  if (new URL(finalUrl).protocol !== 'https:') {
    return makeResult(
      TLS_CERTIFICATE,
      'skip',
      'Skipped tls-certificate: page is not served over HTTPS',
    );
  }
  if (probe === null || probe.error !== null) {
    const reason = probe?.error ?? 'no probe result';
    return makeResult(
      TLS_CERTIFICATE,
      'skip',
      `Could not read the TLS certificate (${quoteUntrusted(reason)})`,
    );
  }
  const daysLeft =
    probe.validTo === null
      ? null
      : Math.floor((Date.parse(probe.validTo) - now.getTime()) / MS_PER_DAY);
  if (!probe.authorized) {
    const code = probe.authorizationError ?? 'unknown error';
    const incomplete =
      code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'
        ? ' The server may not send its intermediate certificate; clients other than browsers cannot fetch it.'
        : '';
    return makeResult(
      TLS_CERTIFICATE,
      'fail',
      `Certificate is not trusted (${quoteUntrusted(code)}).${incomplete}`,
      remediation,
    );
  }
  if (probe.protocol !== null && /^TLSv1(\.[01])?$|^SSL/i.test(probe.protocol)) {
    return makeResult(
      TLS_CERTIFICATE,
      'fail',
      `Server negotiated outdated ${quoteUntrusted(probe.protocol)}`,
      remediation,
    );
  }
  if (daysLeft !== null && daysLeft < TLS_FAIL_DAYS) {
    return makeResult(
      TLS_CERTIFICATE,
      'fail',
      daysLeft < 0 ? 'Certificate has expired' : `Certificate expires in ${daysLeft} days`,
      remediation,
    );
  }
  if (daysLeft !== null && daysLeft < TLS_WARN_DAYS) {
    return makeResult(
      TLS_CERTIFICATE,
      'warn',
      `Certificate expires in ${daysLeft} days`,
      remediation,
    );
  }
  const proto = probe.protocol === null ? '' : `, ${quoteUntrusted(probe.protocol)}`;
  return makeResult(
    TLS_CERTIFICATE,
    'pass',
    daysLeft === null
      ? `Certificate is valid${proto}`
      : `Certificate is valid for ${daysLeft} more days${proto}`,
  );
}

export function checkClickjacking(headers: Headers): CheckResult {
  const remediation =
    "Add header: Content-Security-Policy: frame-ancestors 'self' (or X-Frame-Options: SAMEORIGIN) to stop other sites from framing the page.";
  const csp = header(headers, 'content-security-policy');
  const ancestors =
    csp === undefined
      ? []
      : parseCspPolicies(csp)
          .map((policy) => policy.get('frame-ancestors'))
          .filter((sources): sources is string[] => sources !== undefined && sources.length > 0);
  if (ancestors.some((sources) => !sources.includes('*'))) {
    return makeResult(CLICKJACKING, 'pass', 'Framing is restricted by CSP frame-ancestors');
  }
  const xfo = header(headers, 'x-frame-options');
  const values = xfo?.split(',').map((v) => v.trim().toLowerCase()) ?? [];
  if (values.some((v) => v === 'deny' || v === 'sameorigin')) {
    return makeResult(
      CLICKJACKING,
      'pass',
      `X-Frame-Options is ${quoteUntrusted(values.join(', '))}`,
    );
  }
  if (ancestors.length > 0) {
    return makeResult(
      CLICKJACKING,
      'warn',
      'CSP frame-ancestors allows any site to frame the page (*)',
      remediation,
    );
  }
  if (values.some((v) => v.startsWith('allow-from'))) {
    return makeResult(
      CLICKJACKING,
      'warn',
      'Only X-Frame-Options ALLOW-FROM is set, which browsers ignore',
      remediation,
    );
  }
  return makeResult(
    CLICKJACKING,
    'fail',
    'Page can be framed by any site (no frame-ancestors or X-Frame-Options)',
    remediation,
  );
}

interface CookieFlags {
  secure: boolean;
  httpOnly: boolean;
  sameSite: string | null;
}

function parseSetCookie(value: string): CookieFlags {
  const flags: CookieFlags = { secure: false, httpOnly: false, sameSite: null };
  for (const part of value.split(';').slice(1)) {
    const [name, v] = splitDirective(part);
    if (name === 'secure') flags.secure = true;
    else if (name === 'httponly') flags.httpOnly = true;
    else if (name === 'samesite') flags.sameSite = v.toLowerCase();
  }
  return flags;
}

export function checkCookieFlags(setCookies: string[], finalUrl: string): CheckResult {
  const remediation =
    'Set cookies with Secure; HttpOnly; SameSite=Lax (or Strict). SameSite=None requires Secure.';
  if (setCookies.length === 0) {
    return makeResult(COOKIE_FLAGS, 'pass', 'No cookies are set');
  }
  const cookies = setCookies.map(parseSetCookie);
  const n = cookies.length;
  const noun = n === 1 ? 'cookie' : 'cookies';
  const https = new URL(finalUrl).protocol === 'https:';
  const count = (pred: (c: CookieFlags) => boolean) => cookies.filter(pred).length;
  const noSecure = https ? count((c) => !c.secure) : 0;
  const badNone = count((c) => c.sameSite === 'none' && !c.secure);
  const noHttpOnly = count((c) => !c.httpOnly);
  const noSameSite = count((c) => c.sameSite === null);
  const problems = [
    noSecure > 0 && `${noSecure} of ${n} ${noun} missing Secure`,
    badNone > 0 && `${badNone} of ${n} ${noun} use SameSite=None without Secure`,
    noHttpOnly > 0 && `${noHttpOnly} of ${n} ${noun} missing HttpOnly`,
    noSameSite > 0 && `${noSameSite} of ${n} ${noun} missing SameSite`,
  ].filter((p) => typeof p === 'string');
  if (problems.length === 0) {
    return makeResult(COOKIE_FLAGS, 'pass', `All ${n} ${noun} have Secure, HttpOnly and SameSite`);
  }
  const status = noSecure > 0 || badNone > 0 ? 'fail' : 'warn';
  return makeResult(COOKIE_FLAGS, status, problems.join('; '), remediation);
}

const ACTIVE_RESOURCES: [selector: string, attr: string][] = [
  ['script[src]', 'src'],
  ['link[rel~="stylesheet"][href]', 'href'],
  ['iframe[src]', 'src'],
  ['object[data]', 'data'],
  ['embed[src]', 'src'],
];
const PASSIVE_RESOURCES: [selector: string, attr: string][] = [
  ['img[src]', 'src'],
  ['audio[src]', 'src'],
  ['video[src]', 'src'],
  ['source[src]', 'src'],
];

/** Absolute http:// URLs of the resources matching `sources`, relative ones resolved against `base`. */
function insecureUrls($: CheerioAPI, sources: [string, string][], base: URL): string[] {
  const found: string[] = [];
  for (const [selector, attr] of sources) {
    $(selector).each((_, el) => {
      const raw = $(el).attr(attr)?.trim();
      if (!raw) return;
      try {
        const url = new URL(raw, base);
        if (url.protocol === 'http:') found.push(url.href);
      } catch {
        // Unparseable URLs load nothing.
      }
    });
  }
  return found;
}

export function checkMixedContent($: CheerioAPI, headers: Headers, finalUrl: string): CheckResult {
  const remediation =
    'Load every resource over https:// (change http:// URLs in the HTML, or add Content-Security-Policy: upgrade-insecure-requests as a stopgap).';
  const pageUrl = new URL(finalUrl);
  if (pageUrl.protocol !== 'https:') {
    return makeResult(
      MIXED_CONTENT,
      'skip',
      'Skipped mixed-content: page is not served over HTTPS',
    );
  }
  const csp = header(headers, 'content-security-policy');
  if (csp !== undefined && parseCspPolicies(csp).some((p) => p.has('upgrade-insecure-requests'))) {
    return makeResult(
      MIXED_CONTENT,
      'pass',
      'CSP upgrade-insecure-requests upgrades HTTP resources',
    );
  }
  let base = pageUrl;
  const baseHref = $('base[href]').first().attr('href')?.trim();
  if (baseHref) {
    try {
      base = new URL(baseHref, pageUrl);
    } catch {
      // An invalid <base href> is ignored by browsers.
    }
  }
  const active = insecureUrls($, ACTIVE_RESOURCES, base);
  const passive = insecureUrls($, PASSIVE_RESOURCES, base);
  if (active.length > 0) {
    return makeResult(
      MIXED_CONTENT,
      'fail',
      `${active.length} active resource(s) loaded over HTTP, e.g. ${quoteUntrusted(active[0]!)}`,
      remediation,
    );
  }
  if (passive.length > 0) {
    return makeResult(
      MIXED_CONTENT,
      'warn',
      `${passive.length} image/media resource(s) loaded over HTTP, e.g. ${quoteUntrusted(passive[0]!)}`,
      remediation,
    );
  }
  return makeResult(MIXED_CONTENT, 'pass', 'No resources are loaded over HTTP');
}

export interface SecuritySiteInput extends SecurityInput {
  setCookies: string[];
  /** Null when the handshake was not attempted (e.g. plain HTTP). */
  tls: TlsProbe | null;
  now?: Date;
}

/** Security checks of the page's headers and connection, run once for the site. */
export function runSecurityChecks(page: SecuritySiteInput): CheckResult[] {
  const { headers, finalUrl } = page;
  return [
    safeRun(HTTPS, () => checkHttps(finalUrl)),
    safeRun(HSTS, () => checkHsts(headers, finalUrl)),
    safeRun(CSP, () => checkCsp(headers)),
    safeRun(NOSNIFF, () => checkContentTypeOptions(headers)),
    safeRun(REFERRER, () => checkReferrerPolicy(headers)),
    safeRun(PERMISSIONS, () => checkPermissionsPolicy(headers)),
    safeRun(TLS_CERTIFICATE, () => checkTlsCertificate(page.tls, finalUrl, page.now)),
    safeRun(CLICKJACKING, () => checkClickjacking(headers)),
    safeRun(COOKIE_FLAGS, () => checkCookieFlags(page.setCookies, finalUrl)),
  ];
}

/** Security checks of the page's HTML; run on every analysed page. */
export function runSecurityPageChecks(page: PageInput & SecurityInput): CheckResult[] {
  return [
    safeRunPage(MIXED_CONTENT, page, ($) => checkMixedContent($, page.headers, page.finalUrl)),
  ];
}
