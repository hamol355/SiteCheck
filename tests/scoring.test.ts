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
      availability: { score: 15, max: 15 },
      security: { score: 35, max: 35 },
      seo: { score: 20, max: 20 },
      accessibility: { score: 30, max: 30 },
    });
  });

  it('scores 0 for no checks at all', () => {
    const result = calculateScore([]);
    expect(result.score).toBe(0);
    expect(result.grade).toBe('Poor');
    expect(result.categories.security).toEqual({ score: 0, max: 35 });
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
    expect(result.categories.availability.score).toBe(15);
  });

  it('leaves skipped checks out, scoring a fully skipped category 0', () => {
    const result = calculateScore([
      check('seo', 3, 3),
      check('seo', 0, 4, 'skip'),
      check('accessibility', 0, 5, 'skip'),
    ]);
    expect(result.categories.seo.score).toBe(20);
    expect(result.categories.accessibility).toEqual({ score: 0, max: 30 });
  });

  it('gives a category without checks 0 while the others count normally', () => {
    const result = calculateScore((['availability', 'security', 'seo'] as const).map(full));
    expect(result.categories.accessibility.score).toBe(0);
    expect(result.score).toBe(70);
  });

  it('scores a category without possible points as 0, not NaN', () => {
    const result = calculateScore([check('seo', 0, 0)]);
    expect(result.categories.seo.score).toBe(0);
    expect(Number.isNaN(result.score)).toBe(false);
  });

  it('scales each category by its weight', () => {
    const result = calculateScore([
      check('availability', 5, 10), // half of 15
      check('security', 10, 10), // all of 35
      check('seo', 10, 10), // all of 20
    ]);
    expect(result.categories.availability.score).toBe(8); // 7.5 rounded
    expect(result.categories.security.score).toBe(35);
    expect(result.score).toBe(63); // 62.5 rounded once
    expect(result.grade).toBe('Needs improvement');
  });

  it('sums points across the checks of a category', () => {
    const result = calculateScore([check('seo', 4, 4), check('seo', 0, 4, 'fail')]);
    expect(result.categories.seo.score).toBe(10);
  });

  it('rounds the total once, so rounded categories need not add up to it', () => {
    // availability, seo and accessibility score 1.875, 2.5 and 3.75; security scores 35.
    const result = calculateScore([
      check('availability', 1, 8),
      check('seo', 1, 8),
      check('accessibility', 1, 8),
      check('security', 10, 10),
    ]);
    const categorySum = Object.values(result.categories).reduce((s, c) => s + c.score, 0);
    expect(categorySum).toBe(44); // 2 + 35 + 3 + 4
    expect(result.score).toBe(43); // 43.125 rounded once
  });

  it.each([
    [49, 'Poor'],
    [50, 'Needs improvement'],
    [74, 'Needs improvement'],
    [75, 'Good'],
    [89, 'Good'],
    [90, 'Excellent'],
  ])('a total of %i is graded %s', (target, grade) => {
    // Fill the categories in order (15, 35, 20, 30) until `target` points are placed.
    const result = calculateScore([
      check('availability', Math.min(target, 15), 15),
      check('security', Math.min(Math.max(target - 15, 0), 35), 35),
      check('seo', Math.min(Math.max(target - 50, 0), 20), 20),
      check('accessibility', Math.min(Math.max(target - 70, 0), 30), 30),
    ]);
    expect(result.score).toBe(target);
    expect(result.grade).toBe(grade);
  });
});
