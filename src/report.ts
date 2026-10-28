import type { Category, CheckResult } from './checks/types.js';
import type { CategoryScore, Grade } from './scoring/score.js';

/** The public result of an analysis. The JSON output is this object; change it deliberately. */
export interface Report {
  schemaVersion: 1;
  url: string;
  finalUrl: string;
  score: number;
  grade: Grade;
  categories: Record<Category, CategoryScore>;
  checks: CheckResult[];
  meta: {
    sitecheckVersion: string;
    /** ISO 8601 timestamp. */
    analyzedAt: string;
    responseTimeMs: number;
    /** True if the page was larger than the read limit and only its beginning was analysed. */
    truncated: boolean;
  };
}
