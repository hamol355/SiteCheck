import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyze } from '../src/index.js';
import { renderJson } from '../src/output/json.js';
import { startTestServer, type TestServer } from './helpers/test-server.js';

// Run with UPDATE_GOLDEN=1 to rewrite the fixture after an intentional JSON change.
const GOLDEN = new URL('./fixtures/report.golden.json', import.meta.url);

let server: TestServer;

beforeAll(async () => {
  const html = readFileSync(new URL('./fixtures/good.html', import.meta.url), 'utf8');
  server = await startTestServer({
    '/': {
      body: html,
      headers: {
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      },
    },
    '/robots.txt': { headers: { 'content-type': 'text/plain' }, body: 'User-agent: *\n' },
    '/sitemap.xml': {
      headers: { 'content-type': 'application/xml' },
      body: '<urlset></urlset>',
    },
  });
});

afterAll(async () => {
  await server.close();
});

/** Removes everything that varies between runs: the port and measured timings. */
function normalize(json: string): unknown {
  const text = json
    .replaceAll(server.url, 'http://TEST')
    .replace(/Response time \d+ ms/g, 'Response time N ms');
  const parsed = JSON.parse(text) as { meta: { responseTimeMs: number } };
  parsed.meta.responseTimeMs = 0;
  return parsed;
}

describe('JSON report', () => {
  it('matches the golden fixture', async () => {
    const report = await analyze(`${server.url}/`, {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const actual = normalize(renderJson(report));

    if (process.env['UPDATE_GOLDEN'] || !existsSync(GOLDEN)) {
      writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    }
    expect(actual).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  });
});
