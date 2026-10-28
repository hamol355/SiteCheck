import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type Io } from '../src/cli/main.js';
import {
  EXIT_BELOW_MIN_SCORE,
  EXIT_OK,
  EXIT_UNREACHABLE,
  EXIT_USAGE,
} from '../src/cli/exit-codes.js';
import { analyze as defaultAnalyze, BlockedError } from '../src/index.js';
import type { Report } from '../src/report.js';
import { VERSION } from '../src/version.js';
import { startTestServer, type TestServer } from './helpers/test-server.js';

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(
  args: string[],
  options: {
    env?: Record<string, string | undefined>;
    isTTY?: boolean;
    analyze?: Parameters<typeof main>[2];
  } = {},
): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const io: Io = {
    stdout: (t) => void (stdout += t),
    stderr: (t) => void (stderr += t),
    env: options.env ?? {},
    stdoutIsTTY: options.isTTY ?? false,
  };
  const code = await main(['node', 'sitecheck', ...args], io, options.analyze);
  return { code, stdout, stderr };
}

let server: TestServer;

beforeEach(async () => {
  server = await startTestServer({
    '/': { body: '<html><head><title>A fine test page</title></head><body></body></html>' },
    '/loop': { status: 302, headers: { location: '/loop' } },
  });
});

afterEach(async () => {
  await server.close();
});

describe('cli output', () => {
  it('prints a text report to stdout and exits 0', async () => {
    const r = await run([server.url]);
    expect(r.code).toBe(EXIT_OK);
    expect(r.stdout).toContain('SiteCheck');
    expect(r.stdout).toMatch(/Score: \d+\/100/);
    expect(r.stderr).toBe('');
  });

  it('prints parseable JSON with --format json and nothing on stderr', async () => {
    const r = await run([server.url, '--format', 'json']);
    expect(r.code).toBe(EXIT_OK);
    expect(r.stderr).toBe('');
    const report = JSON.parse(r.stdout) as Report;
    expect(report.schemaVersion).toBe(1);
    expect(report.url).toBe(`${server.url}/`);
    expect(report.meta.sitecheckVersion).toBe(VERSION);
    expect(report.checks.length).toBeGreaterThan(10);
    expect(report.checks[0]).toMatchObject({ id: 'http-status', status: 'pass' });
  });

  it('colors output only for a TTY without NO_COLOR', async () => {
    expect((await run([server.url], { isTTY: true })).stdout).toContain('\x1b[');
    expect((await run([server.url], { isTTY: true, env: { NO_COLOR: '1' } })).stdout).not.toContain(
      '\x1b[',
    );
    expect((await run([server.url], { isTTY: false })).stdout).not.toContain('\x1b[');
  });

  it('prints help and version to stdout and exits 0', async () => {
    const help = await run(['--help']);
    expect(help.code).toBe(EXIT_OK);
    expect(help.stdout).toContain('--min-score');
    expect(help.stdout).toContain('--format');
    const version = await run(['--version']);
    expect(version.code).toBe(EXIT_OK);
    expect(version.stdout.trim()).toBe(VERSION);
  });
});

describe('--min-score', () => {
  it('exits 1 when the score is below the minimum, still printing the report', async () => {
    const r = await run([server.url, '--min-score', '100']);
    expect(r.code).toBe(EXIT_BELOW_MIN_SCORE);
    expect(r.stdout).toContain('Score:');
    expect(r.stderr).toMatch(/below the minimum of 100/);
  });

  it('exits 0 when the score meets the minimum', async () => {
    expect((await run([server.url, '--min-score', '0'])).code).toBe(EXIT_OK);
  });

  it('warns on stderr when checks failed to run, keeping stdout clean', async () => {
    const analyze: Parameters<typeof main>[2] = async (url) => {
      const report = await defaultAnalyze(url);
      const [first, ...rest] = report.checks;
      return { ...report, checks: [{ ...first!, status: 'error' as const }, ...rest] };
    };
    const r = await run([server.url, '--format', 'json'], { analyze });
    expect(r.code).toBe(EXIT_OK);
    expect(r.stderr).toBe('Warning: 1 check failed to run and is not included in the score.\n');
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });

  it('keeps stdout valid JSON when the score is too low', async () => {
    const r = await run([server.url, '--format', 'json', '--min-score', '100']);
    expect(r.code).toBe(EXIT_BELOW_MIN_SCORE);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
  });
});

describe('usage errors (exit 2)', () => {
  it.each([
    ['missing url', []],
    ['unsupported protocol', ['ftp://example.com']],
    ['empty url', ['  ']],
    ['unknown format', ['example.com', '--format', 'xml']],
    ['non-numeric min-score', ['example.com', '--min-score', 'abc']],
    ['min-score above 100', ['example.com', '--min-score', '101']],
    ['negative min-score', ['example.com', '--min-score', '-1']],
    ['fractional min-score', ['example.com', '--min-score', '1.5']],
    ['unknown option', ['example.com', '--nope']],
  ])('%s', async (_name, args) => {
    const r = await run(args);
    expect(r.code).toBe(EXIT_USAGE);
    expect(r.stdout).toBe('');
    expect(r.stderr).not.toBe('');
  });
});

describe('blocked sites (exit 3)', () => {
  const PAGE = '<html><head><title>A fine test page</title></head><body></body></html>';
  let blocking: TestServer;

  beforeEach(async () => {
    blocking = await startTestServer({
      '/': { body: PAGE },
      '/private': { body: PAGE },
      '/robots.txt': {
        headers: { 'content-type': 'text/plain' },
        body: 'User-agent: *\nDisallow: /private\n',
      },
      '/unauthorized': { status: 401 },
      '/rate-limited': { status: 429 },
      '/cloudflare': { status: 200, headers: { 'cf-mitigated': 'challenge' } },
    });
  });

  afterEach(async () => {
    await blocking.close();
  });

  it.each([
    ['/unauthorized', 'The site requires authentication (HTTP 401)'],
    ['/rate-limited', 'The site is rate limiting requests (HTTP 429)'],
    ['/cloudflare', 'The site served a bot-protection challenge'],
    ['/private', 'robots.txt does not allow automated access to this page'],
  ])('refuses %s with a reason, no stdout and no score', async (path, reason) => {
    const r = await run([`${blocking.url}${path}`, '--format', 'json']);
    expect(r.code).toBe(EXIT_UNREACHABLE);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain(`Access not allowed: ${reason}`);
  });

  it('analyses an allowed path on the same site', async () => {
    const r = await run([blocking.url]);
    expect(r.code).toBe(EXIT_OK);
    expect(r.stdout).toMatch(/Score: \d+\/100/);
  });

  it('throws BlockedError with reason, status and url from analyze()', async () => {
    const err = await defaultAnalyze(`${blocking.url}/unauthorized`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BlockedError);
    expect(err).toMatchObject({
      reason: 'unauthorized',
      status: 401,
      url: `${blocking.url}/unauthorized`,
    });
  });
});

describe('unreachable and internal errors (exit 3)', () => {
  it('exits 3 when nothing is listening', async () => {
    const url = server.url;
    await server.close();
    const r = await run([url]);
    expect(r.code).toBe(EXIT_UNREACHABLE);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^Error: /);
  });

  it('exits 3 on a redirect loop', async () => {
    const r = await run([`${server.url}/loop`]);
    expect(r.code).toBe(EXIT_UNREACHABLE);
    expect(r.stderr).toMatch(/Too many redirects/);
  });

  it('exits 3 on an unexpected error and hides the stack by default', async () => {
    const analyze = () => Promise.reject(new Error('kaboom'));
    const r = await run([server.url], { analyze });
    expect(r.code).toBe(EXIT_UNREACHABLE);
    expect(r.stderr).toContain('kaboom');
    expect(r.stderr).not.toContain('at ');
  });

  it('prints the stack with DEBUG=sitecheck', async () => {
    const analyze = () => Promise.reject(new Error('kaboom'));
    const r = await run([server.url], { analyze, env: { DEBUG: 'sitecheck' } });
    expect(r.stderr).toContain('at ');
  });

  it('exits 3 when rendering the report fails', async () => {
    const analyze = () => Promise.resolve({} as Report);
    const r = await run([server.url], { analyze });
    expect(r.code).toBe(EXIT_UNREACHABLE);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('Unexpected error');
  });
});
