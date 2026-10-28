import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import type { TextResponse } from '../src/checks/types.js';
import {
  decodeSitemapBytes,
  filterPageUrls,
  MAX_CHILD_SITEMAPS,
  MAX_SITEMAP_URLS,
  parseSitemapXml,
  readSitemap,
  samplePages,
} from '../src/net/sitemap.js';
import { startTestServer, type TestServer } from './helpers/test-server.js';

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

const urlset = (...locs: string[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs
    .map((l) => `<url><loc>${l}</loc></url>`)
    .join('')}</urlset>`;
const index = (...locs: string[]) =>
  `<sitemapindex>${locs.map((l) => `<sitemap><loc>${l}</loc></sitemap>`).join('')}</sitemapindex>`;
const xml = { 'content-type': 'application/xml' };
const noRobots: TextResponse = { url: '', status: 404, contentType: null, body: '' };
const robots = (body: string): TextResponse => ({
  url: '',
  status: 200,
  contentType: 'text/plain',
  body,
});

describe('parseSitemapXml', () => {
  it('reads urlset locs', () => {
    expect(parseSitemapXml(urlset('https://a.test/1', ' https://a.test/2 '))).toEqual({
      kind: 'urlset',
      locs: ['https://a.test/1', 'https://a.test/2'],
    });
  });

  it('reads sitemapindex locs', () => {
    expect(parseSitemapXml(index('https://a.test/s1.xml'))).toEqual({
      kind: 'index',
      locs: ['https://a.test/s1.xml'],
    });
  });

  it('returns null for HTML and garbage', () => {
    expect(parseSitemapXml('<html><body>Not found</body></html>')).toBeNull();
    expect(parseSitemapXml('')).toBeNull();
  });
});

describe('decodeSitemapBytes', () => {
  it('gunzips by magic number', () => {
    expect(decodeSitemapBytes(gzipSync('<urlset/>'))).toBe('<urlset/>');
  });

  it('refuses a zip bomb', () => {
    const bomb = gzipSync(Buffer.alloc(5_000_000, 'a'));
    expect(bomb.byteLength).toBeLessThan(10_000);
    expect(decodeSitemapBytes(bomb, 1_000_000)).toBeNull();
  });

  it('refuses oversized plain bodies', () => {
    expect(decodeSitemapBytes(Buffer.alloc(100, 'a'), 50)).toBeNull();
  });
});

describe('readSitemap', () => {
  it('reads a plain urlset from /sitemap.xml', async () => {
    const s = await serve({ '/sitemap.xml': { headers: xml, body: urlset('https://x.test/a') } });
    const res = await readSitemap(`${s.url}/`, noRobots);
    expect(res).toEqual({ urls: ['https://x.test/a'], notices: [] });
  });

  it('follows an index and a gzipped child', async () => {
    const s = await serve({
      '/idx.xml': (req, res) => {
        const base = `http://${req.headers.host}`;
        res.writeHead(200, xml).end(index(`${base}/a.xml`, '/b.xml.gz'));
      },
      '/a.xml': { headers: xml, body: urlset('https://x.test/1') },
      '/b.xml.gz': (_req, res) => {
        res
          .writeHead(200, { 'content-type': 'application/gzip' })
          .end(gzipSync(urlset('https://x.test/2')));
      },
    });
    const res = await readSitemap(`${s.url}/`, robots(`Sitemap: ${s.url}/idx.xml`));
    expect(res.urls).toEqual(['https://x.test/1', 'https://x.test/2']);
    expect(res.notices).toEqual([]);
  });

  it('allows the sitemap file on another host', async () => {
    const cdn = await serve({ '/s.xml': { headers: xml, body: urlset('https://x.test/1') } });
    const site = await serve({});
    const res = await readSitemap(`${site.url}/`, robots(`Sitemap: ${cdn.url}/s.xml`));
    expect(res.urls).toEqual(['https://x.test/1']);
  });

  it('notices a missing sitemap', async () => {
    const s = await serve({});
    const res = await readSitemap(`${s.url}/`, noRobots);
    expect(res.urls).toEqual([]);
    expect(res.notices[0]).toContain('No valid sitemap');
  });

  it('notices an HTML page served as sitemap', async () => {
    const s = await serve({ '/sitemap.xml': { body: '<html>soft 404</html>' } });
    expect((await readSitemap(`${s.url}/`, noRobots)).urls).toEqual([]);
  });

  it('ignores a zip bomb child and keeps the rest', async () => {
    const s = await serve({
      '/sitemap.xml': (req, res) => {
        const base = `http://${req.headers.host}`;
        res.writeHead(200, xml).end(index(`${base}/bomb.xml.gz`, `${base}/ok.xml`));
      },
      '/bomb.xml.gz': (_req, res) => {
        res.writeHead(200, {}).end(gzipSync(Buffer.alloc(20 * 1024 * 1024, 'a')));
      },
      '/ok.xml': { headers: xml, body: urlset('https://x.test/ok') },
    });
    const res = await readSitemap(`${s.url}/`, noRobots);
    expect(res.urls).toEqual(['https://x.test/ok']);
    expect(res.notices.join()).toContain('Skipped invalid or oversized');
  });

  it('stops at three levels of indexes', async () => {
    const s = await serve({
      '/sitemap.xml': (req, res) => {
        res.writeHead(200, xml).end(index(`http://${req.headers.host}/l1.xml`));
      },
      '/l1.xml': (req, res) => {
        res.writeHead(200, xml).end(index(`http://${req.headers.host}/l2.xml`));
      },
      '/l2.xml': (req, res) => {
        res.writeHead(200, xml).end(index(`http://${req.headers.host}/l3.xml`));
      },
      '/l3.xml': { headers: xml, body: urlset('https://x.test/deep') },
    });
    const res = await readSitemap(`${s.url}/`, noRobots);
    expect(res.urls).toEqual([]);
    expect(res.notices.join()).toContain('nested more than');
  });

  it('reads at most 10 child sitemaps', async () => {
    const hits = new Set<string>();
    const routes: Parameters<typeof startTestServer>[0] = {
      '/sitemap.xml': (req, res) => {
        const base = `http://${req.headers.host}`;
        const kids = Array.from({ length: 15 }, (_, i) => `${base}/c${i}.xml`);
        res.writeHead(200, xml).end(index(...kids));
      },
    };
    for (let i = 0; i < 15; i++) {
      routes[`/c${i}.xml`] = (_req, res) => {
        hits.add(`c${i}`);
        res.writeHead(200, xml).end(urlset(`https://x.test/${i}`));
      };
    }
    const s = await serve(routes);
    const res = await readSitemap(`${s.url}/`, noRobots);
    expect(hits.size).toBe(MAX_CHILD_SITEMAPS);
    expect(res.urls).toHaveLength(MAX_CHILD_SITEMAPS);
    expect(res.notices.join()).toContain('more than 10');
  });

  it('notices the child sitemap cap only once', async () => {
    const routes: Parameters<typeof startTestServer>[0] = {
      '/sitemap.xml': (req, res) => {
        const base = `http://${req.headers.host}`;
        res.writeHead(200, xml).end(index(`${base}/i1.xml`, `${base}/i2.xml`));
      },
    };
    for (const name of ['i1', 'i2']) {
      routes[`/${name}.xml`] = (req, res) => {
        const base = `http://${req.headers.host}`;
        const kids = Array.from({ length: 15 }, (_, i) => `${base}/${name}-c${i}.xml`);
        res.writeHead(200, xml).end(index(...kids));
      };
    }
    const s = await serve(routes);
    const res = await readSitemap(`${s.url}/`, noRobots);
    expect(res.notices.filter((n) => n.includes('more than 10'))).toHaveLength(1);
  });

  it('notices the URL cap', async () => {
    const locs = Array.from({ length: MAX_SITEMAP_URLS + 1 }, (_, i) => `https://x.test/${i}`);
    const s = await serve({ '/sitemap.xml': { headers: xml, body: urlset(...locs) } });
    const res = await readSitemap(`${s.url}/`, noRobots);
    expect(res.urls).toHaveLength(MAX_SITEMAP_URLS);
    expect(res.notices).toEqual([
      `Sitemap lists more than ${MAX_SITEMAP_URLS} URLs; reading the first ${MAX_SITEMAP_URLS}`,
    ]);
  });

  it('does not notice a sitemap exactly at the URL cap', async () => {
    const locs = Array.from({ length: MAX_SITEMAP_URLS }, (_, i) => `https://x.test/${i}`);
    const s = await serve({ '/sitemap.xml': { headers: xml, body: urlset(...locs) } });
    const res = await readSitemap(`${s.url}/`, noRobots);
    expect(res.urls).toHaveLength(MAX_SITEMAP_URLS);
    expect(res.notices).toEqual([]);
  });
});

describe('filterPageUrls', () => {
  const start = 'https://x.test/';

  it('keeps same-origin http(s) pages, deduplicated without hash', () => {
    expect(
      filterPageUrls(
        ['https://x.test/a', 'https://x.test/a#top', 'https://x.test/b'],
        start,
        noRobots,
      ),
    ).toEqual(['https://x.test/a', 'https://x.test/b']);
  });

  it('drops other origins, www, other schemes and invalid URLs (SSRF guard)', () => {
    expect(
      filterPageUrls(
        [
          'https://evil.test/a',
          'https://www.x.test/a',
          'http://x.test/a',
          'http://169.254.169.254/latest',
          'ftp://x.test/a',
          'not a url',
          'https://x.test/ok',
        ],
        start,
        noRobots,
      ),
    ).toEqual(['https://x.test/ok']);
  });

  it('drops non-HTML file extensions', () => {
    expect(
      filterPageUrls(
        [
          'https://x.test/a.pdf',
          'https://x.test/b.PNG',
          'https://x.test/c.html',
          'https://x.test/d',
        ],
        start,
        noRobots,
      ),
    ).toEqual(['https://x.test/c.html', 'https://x.test/d']);
  });

  it('drops URLs disallowed by robots.txt', () => {
    const r = robots('User-agent: *\nDisallow: /private/');
    expect(filterPageUrls(['https://x.test/private/a', 'https://x.test/public'], start, r)).toEqual(
      ['https://x.test/public'],
    );
  });
});

describe('samplePages', () => {
  const start = 'https://x.test/';

  it('returns only the start page when there are no candidates', () => {
    expect(samplePages(start, [], 10)).toEqual([start]);
  });

  it('always includes the start page first and never duplicates it', () => {
    const out = samplePages(start, [start, 'https://x.test/a'], 5);
    expect(out).toEqual([start, 'https://x.test/a']);
  });

  it('respects the count', () => {
    const candidates = Array.from({ length: 30 }, (_, i) => `https://x.test/p${i}`);
    expect(samplePages(start, candidates, 5)).toHaveLength(5);
    expect(samplePages(start, candidates, 1)).toEqual([start]);
  });

  it('covers every path-segment group before repeating one', () => {
    const blog = Array.from({ length: 20 }, (_, i) => `https://x.test/blog/${i}`);
    const shop = Array.from({ length: 20 }, (_, i) => `https://x.test/shop/${i}`);
    const about = ['https://x.test/about'];
    const out = samplePages(start, [...blog, ...shop, ...about], 4);
    expect(out).toHaveLength(4);
    expect(out.some((u) => u.includes('/blog/'))).toBe(true);
    expect(out.some((u) => u.includes('/shop/'))).toBe(true);
    expect(out).toContain('https://x.test/about');
  });

  it('spreads evenly within a group and is deterministic', () => {
    const candidates = Array.from({ length: 10 }, (_, i) => `https://x.test/a/${i}`);
    const out = samplePages(start, candidates, 3);
    expect(out).toEqual([start, 'https://x.test/a/2', 'https://x.test/a/7']);
    expect(samplePages(start, candidates, 3)).toEqual(out);
  });

  it('spreads a flat site evenly instead of taking the first pages alphabetically', () => {
    const flat = Array.from(
      { length: 100 },
      (_, i) => `https://x.test/post-${String(i).padStart(3, '0')}/`,
    );
    expect(samplePages(start, flat, 5)).toEqual([
      start,
      'https://x.test/post-012/',
      'https://x.test/post-037/',
      'https://x.test/post-062/',
      'https://x.test/post-087/',
    ]);
  });

  it('keeps top-level pages in one group next to sections', () => {
    const blog = Array.from({ length: 10 }, (_, i) => `https://x.test/blog/${i}`);
    const top = ['https://x.test/about', 'https://x.test/contact', 'https://x.test/pricing'];
    const out = samplePages(start, [...top, ...blog], 3);
    expect(out).toHaveLength(3);
    expect(out.filter((u) => top.includes(u))).toHaveLength(1);
    expect(out.filter((u) => u.includes('/blog/'))).toHaveLength(1);
  });
});
