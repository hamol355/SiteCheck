import type { FetchedPage, TextResponse } from './types.js';

export type BlockReason =
  'unauthorized' | 'forbidden' | 'rate-limited' | 'challenge' | 'robots-disallow';

export const BLOCK_MESSAGES: Record<BlockReason, string> = {
  unauthorized: 'The site requires authentication (HTTP 401)',
  forbidden: 'The site refused the request (HTTP 403), probably bot protection or a firewall rule',
  'rate-limited': 'The site is rate limiting requests (HTTP 429)',
  challenge: 'The site served a bot-protection challenge',
  'robots-disallow': 'robots.txt does not allow automated access to this page',
};

/** Shown after every block message. SiteCheck never tries to get past the protection. */
export const BLOCK_HINT =
  'SiteCheck identifies itself honestly and does not try to bypass bot protection. Ask the site owner to allow the SiteCheck user agent, or run it against an environment without bot protection.';

/** Product token matched against robots.txt `User-agent` lines (case-insensitive). */
export const ROBOTS_AGENT = 'SiteCheck';

export class BlockedError extends Error {
  override name = 'BlockedError';

  constructor(
    readonly reason: BlockReason,
    readonly status: number | null,
    readonly url: string,
  ) {
    super(BLOCK_MESSAGES[reason]);
  }
}

/** Statuses on which a challenge page can be recognised from its headers or body. */
const CHALLENGE_STATUSES = new Set([403, 429, 503]);

const CHALLENGE_HEADERS = ['x-datadome', 'x-datadome-cid', 'x-px-block'];

const CHALLENGE_BODY_PATTERNS: RegExp[] = [
  /<title>\s*just a moment\.{0,3}\s*<\/title>/i, // Cloudflare
  /cdn-cgi\/challenge-platform/i, // Cloudflare
  /captcha-delivery\.com/i, // DataDome
  /_px(?:appid|hello|cs)|px-captcha|perimeterx/i, // PerimeterX / HUMAN
  /ak_bmsc|akamai[^<]{0,40}reference/i, // Akamai
  /g-recaptcha|h-captcha|hcaptcha\.com|cf-turnstile/i, // captcha widgets
  /verify you are (?:a )?human|are you a robot/i,
];

function isChallenge(page: Pick<FetchedPage, 'status' | 'headers' | 'html'>): boolean {
  // Cloudflare marks challenges explicitly, whatever the status.
  if (/challenge/i.test(page.headers['cf-mitigated'] ?? '')) return true;
  if (!CHALLENGE_STATUSES.has(page.status)) return false;
  if (CHALLENGE_HEADERS.some((name) => page.headers[name] !== undefined)) return true;
  const { html } = page;
  return html !== null && CHALLENGE_BODY_PATTERNS.some((pattern) => pattern.test(html));
}

interface RobotsRule {
  allow: boolean;
  pattern: RegExp;
  length: number;
}

/** Percent-encodes non-ASCII characters and uppercases escapes so paths compare as RFC 9309 says. */
function normalizeEncoding(path: string): string {
  return path
    .replace(/[^\x00-\x7f]+/gu, (chars) => encodeURIComponent(chars))
    .replace(/%[0-9a-f]{2}/gi, (escape) => escape.toUpperCase());
}

function compilePattern(path: string): RegExp {
  const anchored = path.endsWith('$');
  const body = (anchored ? path.slice(0, -1) : path)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/**
 * Rules that apply to SiteCheck (RFC 9309): the group naming SiteCheck if there is one,
 * otherwise the `*` group. Groups for the same agent are merged.
 */
function rulesFor(robotsTxt: string): RobotsRule[] {
  const own = ROBOTS_AGENT.toLowerCase();
  const named: RobotsRule[] = [];
  const wildcard: RobotsRule[] = [];
  let hasNamed = false;
  let agents: string[] = [];
  let inRules = false;

  // RFC 9309 allows CR, LF or CRLF line endings; a leading BOM would hide the first field.
  for (const raw of robotsTxt.replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
    const match = /^([a-z-]+)\s*:\s*(.*)$/i.exec(raw.replace(/#.*/, '').trim());
    if (!match) continue;
    const field = match[1]?.toLowerCase();
    const value = match[2] ?? '';
    if (field === 'user-agent') {
      if (inRules) agents = [];
      inRules = false;
      agents.push(value.toLowerCase());
      if (value.toLowerCase() === own) hasNamed = true;
    } else if (field === 'allow' || field === 'disallow') {
      inRules = true;
      // An empty Disallow allows everything and has no effect.
      if (value === '') continue;
      const path = normalizeEncoding(value);
      const rule = {
        allow: field === 'allow',
        pattern: compilePattern(path),
        length: path.length,
      };
      if (agents.includes(own)) named.push(rule);
      else if (agents.includes('*')) wildcard.push(rule);
    }
  }
  return hasNamed ? named : wildcard;
}

/** True if robots.txt forbids SiteCheck from fetching `url`. Longest match wins, Allow on ties. */
export function isDisallowedByRobots(robots: TextResponse, url: string): boolean {
  // A missing, unreachable or broken robots.txt (4xx, 5xx, HTML error page) allows everything.
  if (robots.status !== 200) return false;
  if (robots.contentType?.toLowerCase().includes('text/html')) return false;
  const target = new URL(url);
  const path = normalizeEncoding(target.pathname + target.search);
  let best: RobotsRule | null = null;
  for (const rule of rulesFor(robots.body)) {
    if (!rule.pattern.test(path)) continue;
    if (!best || rule.length > best.length || (rule.length === best.length && rule.allow)) {
      best = rule;
    }
  }
  return best !== null && !best.allow;
}

/** Notice for a robots.txt that could not be read because of a server error, or null. */
export function robotsNotice(robots: TextResponse): string | null {
  if (robots.status === null || robots.status < 500) return null;
  return `robots.txt responded with HTTP ${robots.status}; treating it as allowing everything.`;
}

/**
 * Decides whether the site refuses automated visitors. Pure: takes the start page response and
 * robots.txt, returns the reason or null.
 */
export function detectBlock(
  page: Pick<FetchedPage, 'status' | 'headers' | 'html' | 'finalUrl'>,
  robots: TextResponse,
): BlockReason | null {
  if (isChallenge(page)) return 'challenge';
  if (page.status === 401) return 'unauthorized';
  if (page.status === 403) return 'forbidden';
  if (page.status === 429) return 'rate-limited';
  if (isDisallowedByRobots(robots, page.finalUrl)) return 'robots-disallow';
  return null;
}
