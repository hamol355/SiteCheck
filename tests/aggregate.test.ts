import { describe, expect, it } from 'vitest';
import { aggregateCheck, aggregatePages } from '../src/aggregate.js';
import type { CheckResult, Status } from '../src/checks/types.js';
import type { PageResult } from '../src/pages.js';

const POINTS: Record<Status, number> = { pass: 6, warn: 3, fail: 0, error: 0, skip: 0 };

function result(status: Status, message = `msg ${status}`, id = 'image-alt'): CheckResult {
  const r: CheckResult = {
    id,
    category: 'accessibility',
    status,
    message,
    points: POINTS[status],
    maxPoints: 6,
    wcag: ['1.1.1'],
  };
  if (status === 'warn' || status === 'fail') r.remediation = `fix ${message}`;
  return r;
}

const many = (status: Status, n: number) => Array.from({ length: n }, () => result(status));

describe('aggregateCheck', () => {
  it('returns a single counted result unchanged', () => {
    const only = result('warn');
    expect(aggregateCheck([only])).toBe(only);
    expect(aggregateCheck([result('skip'), only, result('error')])).toBe(only);
  });

  it('passes when all pages pass, without remediation', () => {
    const out = aggregateCheck(many('pass', 3));
    expect(out).toMatchObject({ status: 'pass', points: 6, message: 'Passes on all 3 pages' });
    expect(out.remediation).toBeUndefined();
    expect(out.wcag).toEqual(['1.1.1']);
  });

  it('fails when all pages fail', () => {
    const out = aggregateCheck(many('fail', 4));
    expect(out).toMatchObject({ status: 'fail', points: 0, message: '4 of 4 pages: msg fail' });
  });

  it('warns with half the points on 5 pass + 5 fail', () => {
    const out = aggregateCheck([...many('pass', 5), ...many('fail', 5)]);
    expect(out).toMatchObject({ status: 'warn', points: 3, message: '5 of 10 pages: msg fail' });
  });

  it('fails when more than half fail', () => {
    expect(aggregateCheck([...many('pass', 4), ...many('fail', 5)]).status).toBe('fail');
  });

  it('rounds the mean points down', () => {
    // (6 + 6 + 3) / 3 = 5
    expect(aggregateCheck([...many('pass', 2), result('warn')]).points).toBe(5);
    // (6 + 3) / 2 = 4.5 -> 4
    expect(aggregateCheck([result('pass'), result('warn')]).points).toBe(4);
  });

  it('describes the first failing page, preferring fail over warn', () => {
    const out = aggregateCheck([
      result('pass'),
      result('warn', 'one image missing alt'),
      result('fail', 'all images missing alt'),
    ]);
    expect(out).toMatchObject({
      status: 'warn',
      message: '2 of 3 pages: all images missing alt',
      remediation: 'fix all images missing alt',
    });
  });

  it('ignores error and skip results', () => {
    const out = aggregateCheck([result('error'), ...many('pass', 2), result('skip')]);
    expect(out).toMatchObject({ status: 'pass', message: 'Passes on all 2 pages' });
  });

  it('falls back to the first result when nothing counts', () => {
    const first = result('skip');
    expect(aggregateCheck([first, result('error')])).toBe(first);
  });
});

describe('aggregatePages', () => {
  const page = (checks: CheckResult[], skipped?: string): PageResult => ({
    url: 'https://x.test/',
    status: skipped ? null : 200,
    checks,
    ...(skipped !== undefined && { skipped }),
  });

  it('gives one result per check id in the first page order', () => {
    const out = aggregatePages([
      page([result('pass', 'a', 'title'), result('pass', 'b', 'image-alt')]),
      page([result('fail', 'c', 'image-alt'), result('pass', 'd', 'title')]),
    ]);
    expect(out.map((c) => c.id)).toEqual(['title', 'image-alt']);
    expect(out[1]).toMatchObject({ status: 'warn', message: '1 of 2 pages: c' });
  });

  it('does not count skipped pages', () => {
    const out = aggregatePages([page([result('pass')]), page([], 'Not an HTML page')]);
    expect(out).toEqual([result('pass')]);
  });
});
