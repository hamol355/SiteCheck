import { describe, expect, it } from 'vitest';
import type { Category, CheckResult } from '../src/checks/types.js';
import { calculateScore, gradeFor, GRADES, WEIGHTS } from '../src/scoring/score.js';

function check(
  category: Category,
  points: number,
  maxPoints: number,
  status: CheckResult['status'] = 'pass',
): CheckResult {
  return {
    id: `${category}-${points}-${maxPoints}`,
    category,
    status,
    message: '',
    points,
    maxPoints,
  };
}

const full = (category: Category) => check(category, 10, 10);
const allCategories = (make: (c: Category) => CheckResult) =>
  (Object.keys(WEIGHTS) as Category[]).map(make);

describe('weights and grades', () => {
  it('weights add up to 100', () => {
    expect(Object.values(WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('grades are sorted from highest boundary and end at 0', () => {
    const mins: number[] = GRADES.map((g) => g.min);
    expect(mins).toEqual([...mins].sort((a, b) => b - a));
    expect(mins.at(-1)).toBe(0);
  });
});

describe('gradeFor', () => {
  it.each([
    [0, 'Poor'],
    [49, 'Poor'],
    [50, 'Needs improvement'],
    [74, 'Needs improvement'],
    [75, 'Good'],
    [89, 'Good'],
    [90, 'Excellent'],
    [100, 'Excellent'],
  ])('%i is %s', (score, grade) => {
    expect(gradeFor(score)).toBe(grade);
  });
});

describe('calculateScore', () => {
  it('scores 100 when every check earns full points', () => {
    const result = calculateScore(allCategories(full));
    expect(result.score).toBe(100);
    expect(result.grade).toBe('Excellent');
    expect(result.categories).toEqual({
      availability: { score: 20, max: 20 },
      security: { score: 40, max: 40 },
      seo: { score: 20, max: 20 },
      html: { score: 20, max: 20 },
    });
  });

  it('scores 0 for no checks at all', () => {
    const result = calculateScore([]);
    expect(result.score).toBe(0);
    expect(result.grade).toBe('Poor');
    expect(result.categories.security).toEqual({ score: 0, max: 40 });
  });

  it('scores 0 when every check errored', () => {
    const result = calculateScore(allCategories((c) => check(c, 0, 10, 'error')));
    expect(result.score).toBe(0);
    expect(result.grade).toBe('Poor');
  });

  it('leaves errored checks out of the possible points', () => {
    const result = calculateScore([
      check('availability', 10, 10),
      check('availability', 0, 10, 'error'),
    ]);
    expect(result.categories.availability.score).toBe(20);
  });

  it('leaves skipped checks out, scoring a fully skipped category 0', () => {
    const result = calculateScore([
      check('seo', 3, 3),
      check('seo', 0, 4, 'skip'),
      check('html', 0, 5, 'skip'),
    ]);
    expect(result.categories.seo.score).toBe(20);
    expect(result.categories.html).toEqual({ score: 0, max: 20 });
  });

  it('gives a category without checks 0 while the others count normally', () => {
    const result = calculateScore((['availability', 'security', 'seo'] as const).map(full));
    expect(result.categories.html.score).toBe(0);
    expect(result.score).toBe(80);
  });

  it('scores a category without possible points as 0, not NaN', () => {
    const result = calculateScore([check('seo', 0, 0)]);
    expect(result.categories.seo.score).toBe(0);
    expect(Number.isNaN(result.score)).toBe(false);
  });

  it('scales each category by its weight', () => {
    const result = calculateScore([
      check('availability', 5, 10), // half of 20
      check('security', 10, 10), // all of 40
    ]);
    expect(result.categories.availability.score).toBe(10);
    expect(result.categories.security.score).toBe(40);
    expect(result.score).toBe(50);
    expect(result.grade).toBe('Needs improvement');
  });

  it('sums points across the checks of a category', () => {
    const result = calculateScore([check('seo', 4, 4), check('seo', 0, 4, 'fail')]);
    expect(result.categories.seo.score).toBe(10);
  });

  it('rounds the total once, so rounded categories need not add up to it', () => {
    // availability, seo and html each score exactly 2.5 (rounded to 3); security scores 40.
    const result = calculateScore([
      check('availability', 1, 8),
      check('seo', 1, 8),
      check('html', 1, 8),
      check('security', 10, 10),
    ]);
    const categorySum = Object.values(result.categories).reduce((s, c) => s + c.score, 0);
    expect(categorySum).toBe(49);
    expect(result.score).toBe(48); // 47.5 rounded once
  });

  it.each([
    [49, 'Poor'],
    [50, 'Needs improvement'],
    [74, 'Needs improvement'],
    [75, 'Good'],
    [89, 'Good'],
    [90, 'Excellent'],
  ])('a total of %i is graded %s', (target, grade) => {
    // Fill the categories in order (20, 40, 20, 20) until `target` points are placed.
    const result = calculateScore([
      check('availability', Math.min(target, 20), 20),
      check('security', Math.min(Math.max(target - 20, 0), 40), 40),
      check('seo', Math.min(Math.max(target - 60, 0), 20), 20),
      check('html', Math.min(Math.max(target - 80, 0), 20), 20),
    ]);
    expect(result.score).toBe(target);
    expect(result.grade).toBe(grade);
  });
});
