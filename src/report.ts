import type { Category, CheckResult } from './checks/types.js';
import type { CategoryScore, Grade } from './scoring/score.js';

export interface PageReport {
  url: string;
  /** Final HTTP status, or null if the page could not be fetched. */
  status: number | null;
  /** Why the page was not analysed; its `checks` are then empty. */
  skipped?: string;
  checks: Pick<CheckResult, 'id' | 'status' | 'message'>[];
}

/** The public result of an analysis. The JSON output is this object; change it deliberately. */
export interface Report {
  schemaVersion: 1;
  url: string;
  finalUrl: string;
  score: number;
  grade: Grade;
  categories: Record<Category, CategoryScore>;
  checks: CheckResult[];
  /**
   * Per-page details when more than one page was requested (`pages` > 1). The start page comes
   * first. `checks` above holds the aggregated result per check id.
   */
  pages?: PageReport[];
  meta: {
    /** Pages whose checks are included in the report (the start page plus extra pages not skipped). */
    pagesAnalyzed: number;
    sitecheckVersion: string;
    /** ISO 8601 timestamp. */
    analyzedAt: string;
    responseTimeMs: number;
    /** True if the page was larger than the read limit and only its beginning was analysed. */
    truncated: boolean;
  };
}
