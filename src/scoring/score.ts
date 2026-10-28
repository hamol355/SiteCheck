import type { Category, CheckResult } from '../checks/types.js';

/** Category weights; they sum to the maximum score of 100. Preliminary, tune after manual testing. */
export const WEIGHTS: Record<Category, number> = {
  availability: 20,
  security: 40,
  seo: 20,
  html: 20,
};

/** Grade boundaries, highest first. */
export const GRADES = [
  { min: 90, label: 'Excellent' },
  { min: 75, label: 'Good' },
  { min: 50, label: 'Needs improvement' },
  { min: 0, label: 'Poor' },
] as const;

export type Grade = (typeof GRADES)[number]['label'];

export const CATEGORIES = Object.keys(WEIGHTS) as Category[];

export interface CategoryScore {
  score: number;
  max: number;
}

export interface ScoreSummary {
  score: number;
  grade: Grade;
  categories: Record<Category, CategoryScore>;
}

export function gradeFor(score: number): Grade {
  return GRADES.find((g) => score >= g.min)?.label ?? 'Poor';
}

/**
 * Checks that crashed (`error`) or did not apply (`skip`) say nothing about the site, so they
 * are left out of the score.
 */
export function isScored(check: CheckResult): boolean {
  return check.status !== 'error' && check.status !== 'skip';
}

/**
 * Category score = earned / possible points * category weight, rounded to an integer, over the
 * scored checks only (see `isScored`). A category without scored checks (or without possible
 * points) scores 0. The total sums the unrounded category scores and is rounded once, so the
 * rounded category scores may not add up to the total.
 */
export function calculateScore(checks: readonly CheckResult[]): ScoreSummary {
  const categories = {} as Record<Category, CategoryScore>;
  let total = 0;
  for (const category of CATEGORIES) {
    let earned = 0;
    let possible = 0;
    for (const check of checks) {
      if (check.category !== category || !isScored(check)) continue;
      earned += check.points;
      possible += check.maxPoints;
    }
    const exact = possible > 0 ? (earned / possible) * WEIGHTS[category] : 0;
    total += exact;
    categories[category] = { score: Math.round(exact), max: WEIGHTS[category] };
  }
  const score = Math.round(total);
  return { score, grade: gradeFor(score), categories };
}
