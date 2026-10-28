export type Category = 'availability' | 'security' | 'seo' | 'html';
/** `skip`: the check did not apply (e.g. page checks on an error page) and is not scored. */
export type Status = 'pass' | 'warn' | 'fail' | 'error' | 'skip';

export interface CheckDefinition {
  id: string;
  category: Category;
  maxPoints: number;
}

export interface CheckResult {
  id: string;
  category: Category;
  status: Status;
  message: string;
  remediation?: string;
  points: number;
  maxPoints: number;
}

export interface FetchedPage {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  /** Lowercase header names. */
  headers: Record<string, string>;
  /** null when the response content-type is not HTML. */
  html: string | null;
  truncated: boolean;
  /**
   * Time from sending the final request until the response headers are received.
   * Excludes earlier redirects, body reading and parsing. May include DNS/TLS setup
   * unless the connection was reused.
   */
  responseTimeMs: number;
  redirects: { from: string; to: string; status: number }[];
}

export interface TextResponse {
  /** Final URL after redirects. */
  url: string;
  /** null if the request failed (connection error, timeout, too many redirects). */
  status: number | null;
  contentType: string | null;
  body: string;
}

export interface HttpRedirectProbe {
  /** The http:// URL that was requested. */
  url: string;
  /** Status of the last response, or null if a request failed (connection refused, timeout, ...). */
  status: number | null;
  /** Location of the last response. */
  location: string | null;
  /** http:// to http:// redirects followed before the last response. */
  redirects: { from: string; to: string; status: number }[];
}
