export type Category = 'availability' | 'security' | 'seo' | 'accessibility';
/** `skip`: the check did not apply (e.g. page checks on an error page) and is not scored. */
export type Status = 'pass' | 'warn' | 'fail' | 'error' | 'skip';

export interface CheckDefinition {
  id: string;
  category: Category;
  maxPoints: number;
  /** WCAG 2.2 success criteria the check relates to, e.g. ['2.4.4']. */
  wcag?: string[];
}

export interface CheckResult {
  id: string;
  category: Category;
  status: Status;
  message: string;
  remediation?: string;
  points: number;
  maxPoints: number;
  wcag?: string[];
}

export interface FetchedPage {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  /** Lowercase header names. */
  headers: Record<string, string>;
  /** Each `Set-Cookie` header on its own (`fetch` joins them in `headers`, and `Expires` holds commas). */
  setCookies: string[];
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

export interface TlsProbe {
  host: string;
  port: number;
  /** Why no handshake completed (refused, timeout, ...); null when one did. */
  error: string | null;
  /** Whether the chain is trusted by Node's CA store and matches the host. */
  authorized: boolean;
  /** OpenSSL code such as `CERT_HAS_EXPIRED` or `DEPTH_ZERO_SELF_SIGNED_CERT`; null when authorized. */
  authorizationError: string | null;
  /** Negotiated protocol, e.g. `TLSv1.3`. */
  protocol: string | null;
  /** Leaf certificate expiry (ISO 8601). */
  validTo: string | null;
}

export interface StatusProbe {
  /** The URL that was requested. */
  url: string;
  /** Status of the response (redirects are not followed), or null if the request failed. */
  status: number | null;
  /** `Location` header of the response, if any. */
  location: string | null;
}
