import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
  fetchBytes,
  fetchPage,
  fetchText,
  httpVariant,
  NetworkError,
  probeHttpRedirect,
  TimeoutError,
  TooManyRedirectsError,
} from '../src/net/http.js';
import { USER_AGENT } from '../src/version.js';
import { startTestServer, type TestServer } from './helpers/test-server.js';

let server: TestServer;

afterEach(async () => {
  await server?.close();
});

describe('fetchPage', () => {
  describe('basic responses', () => {
    beforeEach(async () => {
      server = await startTestServer({
        '/': { body: '<html><title>Hi</title></html>', headers: { 'X-Custom': 'Yes' } },
        '/json': { headers: { 'content-type': 'application/json' }, body: '{}' },
        '/missing': { status: 404, body: 'nope' },
        '/latin1': (_req, res) => {
          res
            .writeHead(200, { 'content-type': 'text/html; charset="ISO-8859-1"' })
            .end(Buffer.from('<title>Åäö</title>', 'latin1'));
        },
        '/bogus-charset': (_req, res) => {
          res
            .writeHead(200, { 'content-type': 'text/html; charset=no-such-charset' })
            .end(Buffer.from('<title>Åäö</title>', 'utf8'));
        },
        '/ua': (req, res) => {
          res.writeHead(200, { 'content-type': 'text/html' }).end(req.headers['user-agent'] ?? '');
        },
      });
    });

    it('returns status, lowercase headers and html', async () => {
      const page = await fetchPage(`${server.url}/`);
      expect(page.status).toBe(200);
      expect(page.finalUrl).toBe(`${server.url}/`);
      expect(page.headers['x-custom']).toBe('Yes');
      expect(page.html).toContain('<title>Hi</title>');
      expect(page.truncated).toBe(false);
      expect(page.redirects).toEqual([]);
      expect(page.responseTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('sets html to null for non-HTML content', async () => {
      const page = await fetchPage(`${server.url}/json`);
      expect(page.html).toBeNull();
    });

    it('returns 4xx responses instead of throwing', async () => {
      const page = await fetchPage(`${server.url}/missing`);
      expect(page.status).toBe(404);
    });

    it('decodes the body with the charset from Content-Type', async () => {
      const page = await fetchPage(`${server.url}/latin1`);
      expect(page.html).toBe('<title>Åäö</title>');
    });

    it('falls back to UTF-8 for an unknown charset', async () => {
      const page = await fetchPage(`${server.url}/bogus-charset`);
      expect(page.html).toBe('<title>Åäö</title>');
    });

    it('sends the SiteCheck User-Agent', async () => {
      const page = await fetchPage(`${server.url}/ua`);
      expect(page.html).toBe(USER_AGENT);
    });
  });

  describe('redirects', () => {
    beforeEach(async () => {
      server = await startTestServer({
        '/start': { status: 301, headers: { location: '/middle' } },
        '/middle': { status: 302, headers: { location: '/end' } },
        '/end': { body: 'done' },
        '/loop': { status: 302, headers: { location: '/loop' } },
        '/ftp': { status: 302, headers: { location: 'ftp://example.com/' } },
        '/nolocation': { status: 302 },
      });
    });

    it('follows redirects and records them', async () => {
      const page = await fetchPage(`${server.url}/start`);
      expect(page.finalUrl).toBe(`${server.url}/end`);
      expect(page.requestedUrl).toBe(`${server.url}/start`);
      expect(page.redirects).toEqual([
        { from: `${server.url}/start`, to: `${server.url}/middle`, status: 301 },
        { from: `${server.url}/middle`, to: `${server.url}/end`, status: 302 },
      ]);
    });

    it('resolves a relative Location against the current URL after a host change', async () => {
      const other = await startTestServer({
        '/hop': { status: 302, headers: { location: '/end' } },
        '/end': { body: 'other host' },
      });
      try {
        // `/end` exists on both servers, so resolving against the original URL would land on origin.
        const origin = await startTestServer({
          '/start': { status: 301, headers: { location: `${other.url}/hop` } },
          '/end': { body: 'wrong host' },
        });
        try {
          const page = await fetchPage(`${origin.url}/start`);
          expect(page.finalUrl).toBe(`${other.url}/end`);
          expect(page.html).toBe('other host');
        } finally {
          await origin.close();
        }
      } finally {
        await other.close();
      }
    });

    it('throws TooManyRedirectsError on a redirect loop', async () => {
      await expect(fetchPage(`${server.url}/loop`)).rejects.toBeInstanceOf(TooManyRedirectsError);
    });

    it('respects a custom redirect limit', async () => {
      await expect(fetchPage(`${server.url}/start`, { maxRedirects: 1 })).rejects.toBeInstanceOf(
        TooManyRedirectsError,
      );
    });

    it('refuses redirects to other protocols', async () => {
      await expect(fetchPage(`${server.url}/ftp`)).rejects.toBeInstanceOf(NetworkError);
    });

    it('returns a 3xx without Location as the final response', async () => {
      const page = await fetchPage(`${server.url}/nolocation`);
      expect(page.status).toBe(302);
      expect(page.redirects).toEqual([]);
    });
  });

  describe('limits', () => {
    beforeEach(async () => {
      server = await startTestServer({
        '/slow': { delayMs: 500, body: 'late' },
        '/big': { body: 'x'.repeat(10_000) },
      });
    });

    it('throws TimeoutError when the server is too slow', async () => {
      await expect(fetchPage(`${server.url}/slow`, { timeoutMs: 100 })).rejects.toBeInstanceOf(
        TimeoutError,
      );
    });

    it('truncates the body at maxBodyBytes', async () => {
      const page = await fetchPage(`${server.url}/big`, { maxBodyBytes: 1000 });
      expect(page.html).toHaveLength(1000);
      expect(page.truncated).toBe(true);
    });

    it('does not flag bodies under the cap as truncated', async () => {
      const page = await fetchPage(`${server.url}/big`);
      expect(page.html).toHaveLength(10_000);
      expect(page.truncated).toBe(false);
    });
  });

  it('throws NetworkError when nothing is listening', async () => {
    server = await startTestServer({});
    const url = server.url;
    await server.close();
    await expect(fetchPage(url)).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('httpVariant', () => {
  it('drops the port and path for https URLs', () => {
    expect(httpVariant('https://example.com:8443/a/b?x=1#h')).toBe('http://example.com/');
  });

  it('keeps the port for http URLs', () => {
    expect(httpVariant('http://127.0.0.1:8080/a')).toBe('http://127.0.0.1:8080/');
  });
});

describe('probeHttpRedirect', () => {
  it('stops at a redirect to https without requesting it', async () => {
    server = await startTestServer({
      '/': { status: 301, headers: { location: 'https://example.com/' } },
    });
    const probe = await probeHttpRedirect(`${server.url}/page`);
    expect(probe).toEqual({
      url: `${server.url}/`,
      status: 301,
      location: 'https://example.com/',
      redirects: [],
    });
  });

  it('follows http to http redirects until https', async () => {
    server = await startTestServer({
      '/': { status: 301, headers: { location: '/www' } },
      '/www': { status: 308, headers: { location: 'https://www.example.com/' } },
    });
    const probe = await probeHttpRedirect(server.url);
    expect(probe).toEqual({
      url: `${server.url}/`,
      status: 308,
      location: 'https://www.example.com/',
      redirects: [{ from: `${server.url}/`, to: `${server.url}/www`, status: 301 }],
    });
  });

  it('stops following an http redirect loop at maxRedirects', async () => {
    server = await startTestServer({ '/': { status: 302, headers: { location: '/' } } });
    const probe = await probeHttpRedirect(server.url, { maxRedirects: 2 });
    expect(probe.status).toBe(302);
    expect(probe.redirects).toHaveLength(2);
  });

  it('returns status null when aborted by the caller', async () => {
    server = await startTestServer({ '/': { delayMs: 500 } });
    const controller = new AbortController();
    const probing = probeHttpRedirect(server.url, { signal: controller.signal });
    controller.abort();
    expect((await probing).status).toBeNull();
  });

  it('reports a plain 200', async () => {
    server = await startTestServer({ '/': { body: 'hi' } });
    const probe = await probeHttpRedirect(server.url);
    expect(probe.status).toBe(200);
    expect(probe.location).toBeNull();
  });

  it('returns status null when nothing is listening', async () => {
    server = await startTestServer({});
    const url = server.url;
    await server.close();
    expect((await probeHttpRedirect(url)).status).toBeNull();
  });

  it('returns status null on timeout', async () => {
    server = await startTestServer({ '/': { delayMs: 500 } });
    expect((await probeHttpRedirect(server.url, { timeoutMs: 100 })).status).toBeNull();
  });
});

describe('fetchText', () => {
  it('returns status, content-type and body for any content type', async () => {
    server = await startTestServer({
      '/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *' },
      '/old': { status: 301, headers: { location: '/robots.txt' } },
      '/big': { headers: { 'content-type': 'text/plain' }, body: 'x'.repeat(5000) },
    });
    const direct = await fetchText(`${server.url}/robots.txt`);
    expect(direct).toEqual({
      url: `${server.url}/robots.txt`,
      status: 200,
      contentType: 'text/plain',
      body: 'User-agent: *',
    });
    expect((await fetchText(`${server.url}/old`)).url).toBe(`${server.url}/robots.txt`);
    expect((await fetchText(`${server.url}/big`, { maxBodyBytes: 100 })).body).toHaveLength(100);
    expect((await fetchText(`${server.url}/nope`)).status).toBe(404);
  });

  it('accepts any content type, unlike fetchPage', async () => {
    server = await startTestServer({
      '/accept': (req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' }).end(req.headers.accept ?? '');
      },
    });
    expect((await fetchText(`${server.url}/accept`)).body).toBe('*/*');
    expect((await fetchPage(`${server.url}/accept`)).html).toMatch(/^text\/html/);
  });

  it('returns status null instead of throwing on failure', async () => {
    server = await startTestServer({
      '/slow': { delayMs: 500 },
      '/loop': { status: 302, headers: { location: '/loop' } },
    });
    expect((await fetchText(`${server.url}/slow`, { timeoutMs: 100 })).status).toBeNull();
    expect((await fetchText(`${server.url}/loop`)).status).toBeNull();
  });
});

describe('fetchBytes', () => {
  it('returns the raw bytes so gzip survives', async () => {
    const gz = gzipSync('<urlset/>');
    server = await startTestServer({
      '/s.xml.gz': (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/gzip' }).end(gz);
      },
    });
    const res = await fetchBytes(`${server.url}/s.xml.gz`);
    expect(res.status).toBe(200);
    expect(res.contentType).toBe('application/gzip');
    expect(res.bytes.equals(gz)).toBe(true);
    expect(res.truncated).toBe(false);
  });

  it('caps the body and reports truncated', async () => {
    server = await startTestServer({ '/big': { body: 'x'.repeat(100) } });
    const res = await fetchBytes(`${server.url}/big`, { maxBodyBytes: 10 });
    expect(res.bytes.byteLength).toBe(10);
    expect(res.truncated).toBe(true);
  });

  it('never throws: unreachable gives status null', async () => {
    server = await startTestServer({});
    const url = `${server.url}/`;
    await server.close();
    const res = await fetchBytes(url, { timeoutMs: 500 });
    expect(res.status).toBeNull();
    expect(res.bytes.byteLength).toBe(0);
  });
});
