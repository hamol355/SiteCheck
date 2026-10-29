import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EXIT_BELOW_MIN_SCORE,
  EXIT_OK,
  EXIT_UNREACHABLE,
  EXIT_USAGE,
} from '../src/cli/exit-codes.js';
import type { Report } from '../src/report.js';
import { VERSION } from '../src/version.js';
import { startTestServer, type TestServer } from './helpers/test-server.js';

const execFileAsync = promisify(execFile);

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSC = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
const CLI = fileURLToPath(new URL('../dist/cli/index.js', import.meta.url));

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const goodHeaders = JSON.parse(fixture('headers-good.json')) as Record<string, string>;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the built CLI as a real child process. */
async function sitecheck(args: string[], env: Record<string, string> = {}): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env, NO_COLOR: '1', ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    if (typeof e.code !== 'number') throw err;
    return { code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

let server: TestServer;

beforeAll(async () => {
  await execFileAsync(process.execPath, [TSC], { cwd: ROOT });
  server = await startTestServer({
    '/good': { body: fixture('good.html'), headers: goodHeaders },
    '/bad': { body: fixture('bad.html') },
    '/slow': { body: fixture('good.html'), headers: goodHeaders, delayMs: 1600 },
    '/loop': { status: 302, headers: { location: '/loop' } },
    '/forbidden': { status: 403, body: '<p>Forbidden</p>' },
    '/challenge': {
      status: 403,
      body: '<html><head><title>Just a moment...</title></head></html>',
    },
    '/multi/': { body: fixture('good.html'), headers: goodHeaders },
    '/multi/a': { body: fixture('good.html'), headers: goodHeaders },
    '/multi/b': { body: fixture('bad.html') },
    '/multi/blocked': { status: 403, body: '<p>Forbidden</p>' },
    '/sitemap.xml': (req, res) => {
      const origin = `http://${req.headers.host}`;
      const locs = ['/multi/a', '/multi/b', '/multi/blocked'].map(
        (path) => `<url><loc>${origin}${path}</loc></url>`,
      );
      res.writeHead(200, { 'content-type': 'application/xml' });
      res.end(`<urlset>${locs.join('')}</urlset>`);
    },
    '/server-error': { status: 500, body: '<p>Oops</p>' },
  });
}, 60_000);

afterAll(async () => {
  await server?.close();
});

describe('built CLI', () => {
  it('prints the version and help', async () => {
    const version = await sitecheck(['--version']);
    expect(version.code).toBe(EXIT_OK);
    expect(version.stdout.trim()).toBe(VERSION);

    const help = await sitecheck(['--help']);
    expect(help.code).toBe(EXIT_OK);
    expect(help.stdout).toContain('--min-score');
  });

  it('reports a well configured site as text on stdout only', async () => {
    const r = await sitecheck([`${server.url}/good`]);
    expect(r.code).toBe(EXIT_OK);
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(/Score: \d+\/100/);
    expect(r.stdout).toContain('Permissions-Policy is set');
  });

  it('scores a bad site lower than a good one, with remediation', async () => {
    const good = JSON.parse((await sitecheck([`${server.url}/good`, '--format', 'json'])).stdout);
    const badRun = await sitecheck([`${server.url}/bad`, '--format', 'json']);
    const bad = JSON.parse(badRun.stdout) as Report;

    expect(badRun.code).toBe(EXIT_OK);
    expect(badRun.stderr).toBe('');
    expect(bad.score).toBeLessThan((good as Report).score);
    expect(bad.checks.find((c) => c.id === 'content-security-policy')).toMatchObject({
      status: 'fail',
    });
    expect(bad.checks.some((c) => c.remediation)).toBe(true);
  });

  it('emits a complete JSON report that can be piped', async () => {
    const r = await sitecheck([`${server.url}/good`, '--format', 'json']);
    expect(r.code).toBe(EXIT_OK);
    expect(r.stderr).toBe('');
    const report = JSON.parse(r.stdout) as Report;
    expect(report.schemaVersion).toBe(1);
    expect(Object.keys(report.categories).sort()).toEqual([
      'accessibility',
      'availability',
      'security',
      'seo',
    ]);
    expect(report.meta.sitecheckVersion).toBe(VERSION);
  });

  it('exits 0 for a 404 page and reports http-status as failed', async () => {
    const r = await sitecheck([`${server.url}/missing`, '--format', 'json']);
    expect(r.code).toBe(EXIT_OK);
    const report = JSON.parse(r.stdout) as Report;
    expect(report.checks.find((c) => c.id === 'http-status')).toMatchObject({ status: 'fail' });
  });

  it('skips the page checks for a 404 and shows accessibility as not checked', async () => {
    const json = JSON.parse(
      (await sitecheck([`${server.url}/missing`, '--format', 'json'])).stdout,
    );
    const report = json as Report;
    const skipped = report.checks.filter((c) => c.status === 'skip').map((c) => c.id);
    expect(skipped).toEqual([
      'tls-certificate',
      'mixed-content',
      'title',
      'meta-description',
      'h1',
      'canonical-url',
      'viewport-meta',
      'indexable',
      'html-lang',
      'html-lang-valid',
      'image-alt',
      'heading-structure',
      'link-name',
      'button-name',
      'form-label',
      'iframe-title',
      'landmarks',
      'aria-valid',
      'zoom-allowed',
      'tabindex',
      'meta-refresh',
      'table-headers',
      'autocomplete',
      'media-autoplay',
    ]);
    expect(report.categories.accessibility.score).toBe(0);

    const text = await sitecheck([`${server.url}/missing`]);
    expect(text.stdout).toContain('Accessibility (not checked)');
    expect(text.stdout).toContain('– Skipped html-lang: page responded with HTTP 404');
    expect(text.stderr).toBe('');
  });

  it('flags a slow response in response-time', async () => {
    const r = await sitecheck([`${server.url}/slow`, '--format', 'json']);
    expect(r.code).toBe(EXIT_OK);
    const report = JSON.parse(r.stdout) as Report;
    expect(report.checks.find((c) => c.id === 'response-time')).toMatchObject({ status: 'fail' });
    expect(report.meta.responseTimeMs).toBeGreaterThanOrEqual(1500);
  });

  it('exits 1 with the report intact when below --min-score', async () => {
    const r = await sitecheck([`${server.url}/bad`, '--format', 'json', '--min-score', '100']);
    expect(r.code).toBe(EXIT_BELOW_MIN_SCORE);
    expect(r.stderr).toMatch(/below the minimum of 100/);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });

  it('analyses sitemap pages with --pages and skips a blocked one', async () => {
    const r = await sitecheck([`${server.url}/multi/`, '--pages', '4', '--format', 'json']);
    expect(r.code).toBe(EXIT_OK);
    const report = JSON.parse(r.stdout) as Report;
    expect(report.pages?.map((p) => p.url.replace(server.url, ''))).toEqual([
      '/multi/',
      '/multi/a',
      '/multi/b',
      '/multi/blocked',
    ]);
    expect(report.pages?.find((p) => p.url.endsWith('/blocked'))?.skipped).toBeTruthy();
    expect(report.meta.pagesAnalyzed).toBe(3);

    const text = await sitecheck([`${server.url}/multi/`, '--pages', '4']);
    expect(text.stdout).toContain('Pages analysed: 3 (1 skipped)');
    expect(text.stdout).toContain(`${server.url}/multi/b`);
  });

  it('gives the same report shape for --pages 1 as without the flag', async () => {
    const r = await sitecheck([`${server.url}/good`, '--pages', '1', '--format', 'json']);
    const report = JSON.parse(r.stdout) as Report;
    expect(report.pages).toBeUndefined();
    expect(report.meta.pagesAnalyzed).toBe(1);
  });

  it('exits 2 for --pages out of range', async () => {
    const r = await sitecheck([`${server.url}/good`, '--pages', '51']);
    expect(r.code).toBe(EXIT_USAGE);
    expect(r.stdout).toBe('');
  });

  it('exits 3 on a redirect loop', async () => {
    const r = await sitecheck([`${server.url}/loop`]);
    expect(r.code).toBe(EXIT_UNREACHABLE);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/Too many redirects/);
  });

  it.each([
    ['/forbidden', /^Access not allowed: The site refused the request \(HTTP 403\)/],
    ['/challenge', /^Access not allowed: The site served a bot-protection challenge/],
  ])('exits 3 with "Access not allowed" and no stdout for %s', async (path, message) => {
    const r = await sitecheck([`${server.url}${path}`, '--format', 'json']);
    expect(r.code).toBe(EXIT_UNREACHABLE);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(message);
    expect(r.stderr).toContain('does not try to bypass');
  });

  it('still reports a normal page for a 500 response', async () => {
    const r = await sitecheck([`${server.url}/server-error`, '--format', 'json']);
    expect(r.code).toBe(EXIT_OK);
    const report = JSON.parse(r.stdout) as Report;
    expect(report.checks.find((c) => c.id === 'http-status')).toMatchObject({ status: 'fail' });
  });

  it('exits 3 when nothing is listening', async () => {
    const r = await sitecheck(['localhost:1']);
    expect(r.code).toBe(EXIT_UNREACHABLE);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^Error: /);
  });

  it('exits 2 on invalid input without writing to stdout', async () => {
    for (const args of [[], ['ftp://example.com'], [server.url, '--format', 'xml']]) {
      const r = await sitecheck(args);
      expect(r.code).toBe(EXIT_USAGE);
      expect(r.stdout).toBe('');
      expect(r.stderr).not.toBe('');
    }
  });
});
