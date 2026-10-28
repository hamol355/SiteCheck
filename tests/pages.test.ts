import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { TextResponse } from '../src/checks/types.js';
import {
  analyzeExtraPages,
  analyzePage,
  fetchAndAnalyzePage,
  mapLimit,
  PAGE_CONCURRENCY,
} from '../src/pages.js';
import { startTestServer, type TestServer } from './helpers/test-server.js';

const good = readFileSync(new URL('./fixtures/good.html', import.meta.url), 'utf8');

let servers: TestServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});
async function serve(routes: Parameters<typeof startTestServer>[0]): Promise<TestServer> {
  const server = await startTestServer(routes);
  servers.push(server);
  return server;
}

const noRobots: TextResponse = { url: '', status: 404, contentType: null, body: '' };

describe('analyzePage', () => {
  it('runs the seo page checks and then accessibility, nothing site-wide', () => {
    const checks = analyzePage({ html: good, status: 200 });
    const categories = [...new Set(checks.map((c) => c.category))];
    expect(categories).toEqual(['seo', 'accessibility']);
    const ids = checks.map((c) => c.id);
    expect(ids).toContain('title');
    expect(ids).not.toContain('robots-txt');
    expect(ids).not.toContain('sitemap-xml');
  });

  it('skips the page checks on an error status', () => {
    const checks = analyzePage({ html: good, status: 500 });
    expect(checks.every((c) => c.status === 'skip')).toBe(true);
  });
});

describe('mapLimit', () => {
  it('keeps order and never exceeds the limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3, 0], 2, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, n * 5));
      inFlight--;
      return n * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30, 0]);
    expect(peak).toBe(2);
  });

  it('handles an empty list', async () => {
    expect(await mapLimit([], 4, async () => 1)).toEqual([]);
  });
});

describe('fetchAndAnalyzePage', () => {
  it('analyses an HTML page', async () => {
    const s = await serve({ '/a': { body: good } });
    const res = await fetchAndAnalyzePage(`${s.url}/a`, noRobots);
    expect(res.status).toBe(200);
    expect(res.skipped).toBeUndefined();
    expect(res.checks.map((c) => c.id)).toContain('image-alt');
  });

  it('skips an error status', async () => {
    const s = await serve({});
    const res = await fetchAndAnalyzePage(`${s.url}/missing`, noRobots);
    expect(res).toEqual({
      url: `${s.url}/missing`,
      status: 404,
      skipped: 'Responded with HTTP 404',
      checks: [],
    });
  });

  it('skips a non-HTML page', async () => {
    const s = await serve({ '/data': { headers: { 'content-type': 'application/json' } } });
    expect((await fetchAndAnalyzePage(`${s.url}/data`, noRobots)).skipped).toBe('Not an HTML page');
  });

  it('skips a blocked page instead of throwing', async () => {
    const s = await serve({ '/a': { status: 403 } });
    const res = await fetchAndAnalyzePage(`${s.url}/a`, noRobots);
    expect(res.status).toBe(403);
    expect(res.skipped).toMatch(/^Access not allowed: .*HTTP 403/);
  });

  it('skips a page that redirects into a robots.txt Disallow', async () => {
    const s = await serve({
      '/old': { status: 301, headers: { location: '/private/new' } },
      '/private/new': { body: good },
    });
    const robots: TextResponse = {
      url: `${s.url}/robots.txt`,
      status: 200,
      contentType: 'text/plain',
      body: 'User-agent: *\nDisallow: /private/',
    };
    const res = await fetchAndAnalyzePage(`${s.url}/old`, robots);
    expect(res.skipped).toContain('robots.txt');
  });

  it('never requests a cross-origin redirect target', async () => {
    let hit = false;
    const other = await serve({
      '/': (_req, res) => {
        hit = true;
        res.end(good);
      },
    });
    const s = await serve({ '/a': { status: 302, headers: { location: `${other.url}/` } } });
    const res = await fetchAndAnalyzePage(`${s.url}/a`, noRobots);
    expect(res.status).toBeNull();
    expect(res.skipped).toContain('another origin');
    expect(hit).toBe(false);
  });

  it('skips an unreachable page', async () => {
    const s = await serve({});
    const url = `${s.url}/a`;
    await s.close();
    servers = [];
    const res = await fetchAndAnalyzePage(url, noRobots);
    expect(res.status).toBeNull();
    expect(res.skipped).toContain('Could not fetch');
  });
});

describe('analyzeExtraPages', () => {
  it(`fetches at most ${PAGE_CONCURRENCY} pages at a time and keeps order`, async () => {
    let inFlight = 0;
    let peak = 0;
    const routes: Parameters<typeof startTestServer>[0] = {};
    for (let i = 0; i < 10; i++) {
      routes[`/p${i}`] = (_req, res) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        setTimeout(() => {
          inFlight--;
          res.writeHead(200, { 'content-type': 'text/html' }).end(good);
        }, 20);
      };
    }
    const s = await serve(routes);
    const urls = Array.from({ length: 10 }, (_, i) => `${s.url}/p${i}`);
    const results = await analyzeExtraPages(urls, noRobots);
    expect(results.map((r) => r.url)).toEqual(urls);
    expect(results.every((r) => r.skipped === undefined)).toBe(true);
    expect(peak).toBeLessThanOrEqual(PAGE_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
  });
});
