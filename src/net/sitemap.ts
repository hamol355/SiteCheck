import { gunzipSync } from 'node:zlib';
import * as cheerio from 'cheerio';
import { isDisallowedByRobots } from '../checks/blocked.js';
import { resolveSitemapUrl } from '../checks/seo.js';
import type { TextResponse } from '../checks/types.js';
import { fetchBytes } from './http.js';

/** Sitemap index nesting: the root may be an index, and so may its children (2 levels). */
export const MAX_INDEX_DEPTH = 2;
export const MAX_CHILD_SITEMAPS = 10;
export const MAX_SITEMAP_URLS = 5_000;
/** Cap on a sitemap's size after gunzip (zip-bomb protection). */
export const MAX_UNPACKED_BYTES = 10 * 1024 * 1024;
/** Compressed sitemaps are read up to this size. */
export const MAX_SITEMAP_BYTES = 5 * 1024 * 1024;

const NON_HTML_EXTENSIONS = new Set([
  'pdf', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp', 'tif', 'tiff',
  'mp3', 'mp4', 'm4a', 'wav', 'ogg', 'webm', 'mov', 'avi', 'zip', 'gz', 'tar', '7z', 'rar',
  'xml', 'json', 'txt', 'csv', 'css', 'js', 'mjs', 'map', 'woff', 'woff2', 'ttf', 'eot',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'exe', 'dmg', 'apk',
]); // prettier-ignore

export interface ParsedSitemap {
  kind: 'urlset' | 'index';
  locs: string[];
}

/** Reads `<loc>` entries from a urlset or sitemapindex. Returns null for anything else. */
export function parseSitemapXml(xml: string): ParsedSitemap | null {
  const $ = cheerio.load(xml, { xml: true });
  const root = $.root().children().first();
  const name = root.prop('tagName')?.toString().toLowerCase();
  if (name !== 'urlset' && name !== 'sitemapindex') return null;
  const locs: string[] = [];
  root.find('loc').each((_, el) => {
    const loc = $(el).text().trim();
    if (loc) locs.push(loc);
  });
  return { kind: name === 'urlset' ? 'urlset' : 'index', locs };
}

/** Gunzips by magic number (fetch does not decompress a .gz file). Returns null if too large. */
export function decodeSitemapBytes(bytes: Buffer, maxUnpacked = MAX_UNPACKED_BYTES): string | null {
  let raw = bytes;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    try {
      raw = gunzipSync(bytes, { maxOutputLength: maxUnpacked });
    } catch {
      return null;
    }
  } else if (bytes.byteLength > maxUnpacked) {
    return null;
  }
  return new TextDecoder('utf-8').decode(raw);
}

export interface SitemapResult {
  /** Raw `<loc>` values from all urlsets read, in document order, at most MAX_SITEMAP_URLS. */
  urls: string[];
  /** Reasons worth telling the user (missing or invalid sitemap, limits hit). */
  notices: string[];
}

function httpUrl(value: string, base?: string): URL | null {
  try {
    const url = new URL(value, base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * Collects page URLs from the site's sitemap (the `Sitemap:` entry in robots.txt, otherwise
 * /sitemap.xml), following sitemap indexes. The sitemap files may live on another host, but only
 * http(s) is accepted. Never throws.
 */
export async function readSitemap(startUrl: string, robots: TextResponse): Promise<SitemapResult> {
  const notices: string[] = [];
  const urls: string[] = [];
  const root = resolveSitemapUrl(startUrl, robots);
  const queue: { url: string; depth: number }[] = [{ url: root, depth: 0 }];
  const seen = new Set<string>([root]);
  let fetched = 0;
  let childCapNoticed = false;

  while (queue.length > 0 && urls.length < MAX_SITEMAP_URLS) {
    const { url, depth } = queue.shift()!;
    const res = await fetchBytes(url, { maxBodyBytes: MAX_SITEMAP_BYTES, timeoutMs: 10_000 });
    fetched++;
    const xml = res.status === 200 ? decodeSitemapBytes(res.bytes) : null;
    const parsed = xml === null || res.truncated ? null : parseSitemapXml(xml);
    if (!parsed) {
      if (depth === 0) notices.push(`No valid sitemap at ${url}`);
      else notices.push(`Skipped invalid or oversized sitemap ${url}`);
      continue;
    }
    if (parsed.kind === 'urlset') {
      const room = MAX_SITEMAP_URLS - urls.length;
      urls.push(...parsed.locs.slice(0, room));
      if (parsed.locs.length > room || (urls.length === MAX_SITEMAP_URLS && queue.length > 0)) {
        notices.push(
          `Sitemap lists more than ${MAX_SITEMAP_URLS} URLs; reading the first ${MAX_SITEMAP_URLS}`,
        );
      }
      continue;
    }
    if (depth >= MAX_INDEX_DEPTH) {
      notices.push(`Skipped sitemap index ${url}: nested more than ${MAX_INDEX_DEPTH} levels`);
      continue;
    }
    for (const loc of parsed.locs) {
      const child = httpUrl(loc, res.url);
      if (!child || seen.has(child.href)) continue;
      if (fetched - 1 + queue.length >= MAX_CHILD_SITEMAPS) {
        if (!childCapNoticed) {
          notices.push(
            `Sitemap index lists more than ${MAX_CHILD_SITEMAPS} sitemaps; reading the first ${MAX_CHILD_SITEMAPS}`,
          );
          childCapNoticed = true;
        }
        break;
      }
      seen.add(child.href);
      queue.push({ url: child.href, depth: depth + 1 });
    }
  }
  return { urls, notices };
}

function stripHash(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = '';
  return copy.href;
}

/**
 * Keeps only pages SiteCheck may analyse: same origin as the start page (SSRF guard), http(s),
 * HTML-looking paths, allowed by robots.txt. Deduplicated; order preserved.
 */
export function filterPageUrls(urls: string[], startUrl: string, robots: TextResponse): string[] {
  const origin = new URL(startUrl).origin;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of urls) {
    const url = httpUrl(raw);
    if (!url || url.origin !== origin) continue;
    const ext = /\.([a-z0-9]+)$/i.exec(url.pathname)?.[1]?.toLowerCase();
    if (ext && NON_HTML_EXTENSIONS.has(ext)) continue;
    const href = stripHash(url);
    if (seen.has(href)) continue;
    seen.add(href);
    if (isDisallowedByRobots(robots, href)) continue;
    out.push(href);
  }
  return out;
}

/**
 * Groups by first path segment, but only when there is a deeper segment: /blog/a and /blog/b
 * share "blog", while top-level pages (/about, /my-post/) share one group so a flat site is
 * sampled evenly instead of taking the first pages alphabetically.
 */
function groupKey(href: string): string {
  const segments = new URL(href).pathname.split('/').filter(Boolean);
  return segments.length > 1 ? segments[0]! : '';
}

/**
 * Picks up to `count` pages including the start page. The rest is spread deterministically:
 * candidates are grouped by path section (so templates like /blog and /products are all
 * covered), groups share the quota round-robin, and each group contributes evenly spaced URLs.
 */
export function samplePages(startUrl: string, candidates: string[], count: number): string[] {
  const start = stripHash(new URL(startUrl));
  const result = [start];
  const groups = new Map<string, string[]>();
  for (const href of candidates) {
    if (href === start) continue;
    const key = groupKey(href);
    const group = groups.get(key);
    if (group) group.push(href);
    else groups.set(key, [href]);
  }
  const keys = [...groups.keys()].sort();
  let remaining = Math.min(
    count - 1,
    [...groups.values()].reduce((n, g) => n + g.length, 0),
  );
  const quota = new Map<string, number>(keys.map((k) => [k, 0]));
  while (remaining > 0) {
    for (const key of keys) {
      if (remaining === 0) break;
      if (quota.get(key)! < groups.get(key)!.length) {
        quota.set(key, quota.get(key)! + 1);
        remaining--;
      }
    }
  }
  for (const key of keys) {
    const group = groups.get(key)!;
    const take = quota.get(key)!;
    for (let i = 0; i < take; i++)
      result.push(group[Math.floor(((i + 0.5) * group.length) / take)]!);
  }
  return result;
}
