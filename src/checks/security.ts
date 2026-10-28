import { quoteUntrusted } from '../text.js';
import { makeResult, safeRun } from './run.js';
import type { CheckDefinition, CheckResult, FetchedPage } from './types.js';

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

export function runSecurityChecks(page: SecurityInput): CheckResult[] {
  const { headers, finalUrl } = page;
  return [
    safeRun(HTTPS, () => checkHttps(finalUrl)),
    safeRun(HSTS, () => checkHsts(headers, finalUrl)),
    safeRun(CSP, () => checkCsp(headers)),
    safeRun(NOSNIFF, () => checkContentTypeOptions(headers)),
    safeRun(REFERRER, () => checkReferrerPolicy(headers)),
    safeRun(PERMISSIONS, () => checkPermissionsPolicy(headers)),
  ];
}
