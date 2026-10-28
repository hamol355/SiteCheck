import type { Report } from '../report.js';

export function renderJson(report: Report): string {
  return JSON.stringify(report, null, 2) + '\n';
}
