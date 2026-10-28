import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { analyze } from '../src/index.js';
import { startTestServer, type Route, type TestServer } from './helpers/test-server.js';

const good = readFileSync(new URL('./fixtures/good.html', import.meta.url), 'utf8');
const bad = readFileSync(new URL('./fixtures/bad.html', import.meta.url), 'utf8');

const urlset = (...locs: string[]) =>
  `<urlset>${locs.map((l) => `<url><loc>${l}</loc></url>`).join('')}</urlset>`;

let server: TestServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** A site with a good start page, a good and a bad page, a blocked page and a dead page. */
async function site(sitemap?: (base: string) => string) {
  const hits: string[] = [];
  const page = (body: string, status = 200) => ({ status, body });
  const routes: Record<string, Route> = {
    '/': page(good),
    '/a': page(good),
    '/b': page(bad),
    '/blocked': page('', 403),
    '/private/x': page(good),
    '/robots.txt': {
      headers: { 'content-type': 'text/plain' },
      body: 'User-agent: *\nDisallow: /private/\n',
    },
    '/sitemap.xml': (req, res) => {
      const base = `http://${req.headers.host}`;
      const body = sitemap
        ? sitemap(base)
        : urlset(
            `${base}/`,
            `${base}/a`,
            `${base}/b`,
            `${base}/blocked`,
            `${base}/missing`,
            `${base}/private/x`,
            'https://other.test/x',
          );
      res.writeHead(200, { 'content-type': 'application/xml' }).end(body);
    },
  };
  // Record every request so the test can assert what was (not) fetched.
  const tracked: Record<string, Route> = {};
  for (const [path, route] of Object.entries(routes)) {
    tracked[path] = (req, res) => {
      hits.push(path);
      if (typeof route === 'function') return route(req, res);
      res
        .writeHead(route.status ?? 200, { 'content-type': 'text/html', ...route.headers })
        .end(route.body ?? '');
    };
  }
  const s = await startTestServer(tracked);
  server = s;
  return { url: `${s.url}/`, base: s.url, hits };
}

describe('analyze with pages', () => {
  it('with pages 1 analyses only the start page and has no pages field', async () => {
    const { url, hits } = await site();
    const report = await analyze(url);
    expect(report.pages).toBeUndefined();
    expect(report.meta.pagesAnalyzed).toBe(1);
    expect(hits.filter((h) => h === '/sitemap.xml')).toHaveLength(1);
    expect(hits).not.toContain('/a');
  });

  it('analyses sitemap pages, skips blocked ones and counts dead ones', async () => {
    const { url, base, hits } = await site();
    const report = await analyze(url, { pages: 10 });

    expect(report.pages!.map((p) => p.url)).toEqual([
      url,
      `${base}/a`,
      `${base}/b`,
      `${base}/blocked`,
      `${base}/missing`,
    ]);
    const blocked = report.pages!.find((p) => p.url.endsWith('/blocked'))!;
    expect(blocked.skipped).toMatch(/^Access not allowed/);
    expect(blocked.checks).toEqual([]);
    expect(report.meta.pagesAnalyzed).toBe(4);

    // Sitemap fetched once; robots-disallowed and other-origin URLs never requested.
    expect(hits.filter((h) => h === '/sitemap.xml')).toHaveLength(1);
    expect(hits).not.toContain('/private/x');

    // One result per check id; /b and /missing fail image-alt.
    expect(report.checks.filter((c) => c.id === 'image-alt')).toHaveLength(1);
    expect(report.checks.find((c) => c.id === 'image-alt')).toMatchObject({
      status: 'warn',
      message: expect.stringMatching(/^2 of 4 pages: /),
    });
    // Site-wide checks come from the start page only.
    expect(report.checks.find((c) => c.id === 'sitemap-xml')?.message).toContain('Sitemap found');
    const missing = report.pages!.find((p) => p.url.endsWith('/missing'))!;
    expect(missing.status).toBe(404);
    expect(missing.checks.every((c) => c.status === 'fail')).toBe(true);
    expect(Object.keys(missing.checks[0]!).sort()).toEqual(['id', 'message', 'status']);
  });

  it('respects the page count', async () => {
    const { url } = await site();
    const report = await analyze(url, { pages: 3 });
    expect(report.pages).toHaveLength(3);
  });

  it('falls back to the start page with a notice when the sitemap has no usable URLs', async () => {
    const { url } = await site(() => urlset('https://other.test/a'));
    const notices: string[] = [];
    const report = await analyze(url, { pages: 5, onNotice: (m) => notices.push(m) });
    expect(report.pages).toHaveLength(1);
    expect(notices.join()).toContain('Sitemap has no URLs on');
  });

  it('notices an invalid sitemap', async () => {
    const { url } = await site(() => '<html>soft 404</html>');
    const notices: string[] = [];
    const report = await analyze(url, { pages: 5, onNotice: (m) => notices.push(m) });
    expect(report.pages).toHaveLength(1);
    expect(notices.join()).toContain('No valid sitemap');
    expect(notices.join()).not.toContain('Sitemap has no URLs');
  });

  it.each([0, 51, 2.5, Number.NaN])('rejects pages = %s', async (pages) => {
    await expect(analyze('http://127.0.0.1:1/', { pages })).rejects.toBeInstanceOf(RangeError);
  });
});
