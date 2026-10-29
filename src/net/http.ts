import { connect, type TLSSocket } from 'node:tls';
import { isIP } from 'node:net';
import type {
  FetchedPage,
  HttpRedirectProbe,
  StatusProbe,
  TextResponse,
  TlsProbe,
} from '../checks/types.js';
import { quoteUntrusted } from '../text.js';
import { USER_AGENT } from '../version.js';

export const DEFAULT_TIMEOUT_MS = 10_000;
export const DEFAULT_MAX_REDIRECTS = 5;
export const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface FetchOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  maxBodyBytes?: number;
  /** Refuse redirects to another origin (before requesting them) with `CrossOriginRedirectError`. */
  sameOrigin?: boolean;
}

export class NetworkError extends Error {
  override name = 'NetworkError';
}

export class TimeoutError extends Error {
  override name = 'TimeoutError';
}

export class TooManyRedirectsError extends Error {
  override name = 'TooManyRedirectsError';
}

export class CrossOriginRedirectError extends Error {
  override name = 'CrossOriginRedirectError';
}

function describeCause(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause;
    if (cause instanceof Error) {
      const code = (cause as { code?: unknown }).code;
      return typeof code === 'string' ? `${code}: ${cause.message}` : cause.message;
    }
    return err.message;
  }
  return String(err);
}

function toFetchError(err: unknown, url: string, signal: AbortSignal, timeoutMs: number): Error {
  if (signal.aborted) return new TimeoutError(`Timed out after ${timeoutMs} ms fetching ${url}`);
  return new NetworkError(`Could not fetch ${url} (${describeCause(err)})`);
}

function isHttp(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function isHtml(contentType: string | null): boolean {
  if (!contentType) return false;
  const type = contentType.toLowerCase();
  return type.includes('text/html') || type.includes('application/xhtml+xml');
}

/**
 * Decoder for the charset in a Content-Type header, falling back to UTF-8 when it is missing or
 * unknown. A charset declared only in <meta> inside the document is not detected.
 */
function decoderFor(contentType: string | null): TextDecoder {
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType ?? '')?.[1];
  if (charset) {
    try {
      return new TextDecoder(charset);
    } catch {
      // Unknown label; fall back to UTF-8.
    }
  }
  return new TextDecoder('utf-8');
}

async function readCapped(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  if (!body) return { bytes: Buffer.alloc(0), truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - size;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        truncated = true;
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => undefined);
  }
  return { bytes: Buffer.concat(chunks), truncated };
}

interface RawResponse extends Omit<FetchedPage, 'html' | 'truncated'> {
  /** Raw body, capped at `maxBodyBytes`; null when `shouldRead` rejected the content-type. */
  body: Buffer | null;
  truncated: boolean;
}

/**
 * Follows redirects manually (http/https only) and reads the body if `shouldRead` accepts the
 * content-type. The timeout covers the whole call, including body reading.
 */
async function fetchResource(
  url: string,
  options: FetchOptions,
  shouldRead: (contentType: string | null) => boolean,
  accept: string,
): Promise<RawResponse> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const redirects: FetchedPage['redirects'] = [];
  let current = url;

  try {
    for (;;) {
      const started = performance.now();
      let response: Response;
      try {
        response = await fetch(current, {
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'user-agent': USER_AGENT,
            accept,
          },
        });
      } catch (err) {
        throw toFetchError(err, current, controller.signal, timeoutMs);
      }
      const responseTimeMs = Math.round(performance.now() - started);

      const location = response.headers.get('location');
      if (REDIRECT_STATUSES.has(response.status) && location) {
        await response.body?.cancel().catch(() => undefined);
        if (redirects.length >= maxRedirects) {
          throw new TooManyRedirectsError(`Too many redirects (more than ${maxRedirects})`);
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new NetworkError(
            `Invalid redirect location "${quoteUntrusted(location)}" from ${current}`,
          );
        }
        if (!isHttp(next)) {
          throw new NetworkError(
            `Redirect to unsupported protocol ${next.protocol} from ${current}`,
          );
        }
        if (options.sameOrigin && next.origin !== new URL(url).origin) {
          throw new CrossOriginRedirectError(`Redirects to another origin (${next.origin})`);
        }
        redirects.push({ from: current, to: next.href, status: response.status });
        current = next.href;
        continue;
      }

      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });

      let body: Buffer | null = null;
      let truncated = false;
      const contentType = response.headers.get('content-type');
      if (shouldRead(contentType)) {
        try {
          ({ bytes: body, truncated } = await readCapped(response.body, maxBodyBytes));
        } catch (err) {
          throw toFetchError(err, current, controller.signal, timeoutMs);
        }
      } else {
        await response.body?.cancel().catch(() => undefined);
      }

      return {
        requestedUrl: url,
        finalUrl: current,
        status: response.status,
        headers,
        setCookies: response.headers.getSetCookie(),
        body,
        truncated,
        responseTimeMs,
        redirects,
      };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Fetches a page, following up to `maxRedirects` redirects. Only HTML bodies are read. */
export async function fetchPage(url: string, options: FetchOptions = {}): Promise<FetchedPage> {
  const { body, ...page } = await fetchResource(
    url,
    options,
    isHtml,
    'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  );
  const html = body && decoderFor(page.headers['content-type'] ?? null).decode(body);
  return { ...page, html };
}

export const PROBE_TIMEOUT_MS = 5_000;
export const TEXT_TIMEOUT_MS = 5_000;
export const TEXT_MAX_BODY_BYTES = 1024 * 1024;

/** Fetches a small text resource (robots.txt, sitemap.xml) of any content-type. Never throws. */
export async function fetchText(url: string, options: FetchOptions = {}): Promise<TextResponse> {
  try {
    const page = await fetchResource(
      url,
      {
        timeoutMs: options.timeoutMs ?? TEXT_TIMEOUT_MS,
        maxBodyBytes: options.maxBodyBytes ?? TEXT_MAX_BODY_BYTES,
        ...(options.maxRedirects !== undefined && { maxRedirects: options.maxRedirects }),
      },
      () => true,
      '*/*',
    );
    const contentType = page.headers['content-type'] ?? null;
    return {
      url: page.finalUrl,
      status: page.status,
      contentType,
      body: page.body ? decoderFor(contentType).decode(page.body) : '',
    };
  } catch {
    return { url, status: null, contentType: null, body: '' };
  }
}

export interface BytesResponse {
  url: string;
  status: number | null;
  contentType: string | null;
  /** Raw body (not decoded, so gzip survives), capped at `maxBodyBytes`. */
  bytes: Buffer;
  truncated: boolean;
}

/** Decodes a `fetchBytes` result like `fetchText` would, so one response can serve both uses. */
export function bytesToText(res: BytesResponse): TextResponse {
  return {
    url: res.url,
    status: res.status,
    contentType: res.contentType,
    body: decoderFor(res.contentType).decode(res.bytes),
  };
}

/** Fetches a resource of any content-type as raw bytes (e.g. a gzipped sitemap). Never throws. */
export async function fetchBytes(url: string, options: FetchOptions = {}): Promise<BytesResponse> {
  try {
    const res = await fetchResource(
      url,
      {
        timeoutMs: options.timeoutMs ?? TEXT_TIMEOUT_MS,
        maxBodyBytes: options.maxBodyBytes ?? TEXT_MAX_BODY_BYTES,
        ...(options.maxRedirects !== undefined && { maxRedirects: options.maxRedirects }),
      },
      () => true,
      '*/*',
    );
    return {
      url: res.finalUrl,
      status: res.status,
      contentType: res.headers['content-type'] ?? null,
      bytes: res.body ?? Buffer.alloc(0),
      truncated: res.truncated,
    };
  } catch {
    return { url, status: null, contentType: null, bytes: Buffer.alloc(0), truncated: false };
  }
}

/**
 * Returns the http:// variant of a URL's root. For https URLs the port is dropped (so port 80
 * is probed); an http URL keeps its port.
 */
export function httpVariant(siteUrl: string): string {
  const url = new URL(siteUrl);
  if (url.protocol === 'https:') url.port = '';
  url.protocol = 'http:';
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.href;
}

/**
 * Requests the http:// variant of the site and follows http:// to http:// redirects (e.g. to
 * www) until a response leaves http or is not a redirect. The https target itself is never
 * requested. The timeout covers the whole chain. Never throws.
 */
export async function probeHttpRedirect(
  siteUrl: string,
  options: { timeoutMs?: number; maxRedirects?: number; signal?: AbortSignal } = {},
): Promise<HttpRedirectProbe> {
  const url = httpVariant(siteUrl);
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? PROBE_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const redirects: HttpRedirectProbe['redirects'] = [];
  let current = url;
  try {
    for (;;) {
      const response = await fetch(current, {
        redirect: 'manual',
        signal,
        headers: { 'user-agent': USER_AGENT },
      });
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get('location');
      const last = { url, status: response.status, location, redirects };
      if (!REDIRECT_STATUSES.has(response.status) || !location) return last;
      if (redirects.length >= maxRedirects) return last;
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return last;
      }
      if (next.protocol !== 'http:') return last;
      redirects.push({ from: current, to: next.href, status: response.status });
      current = next.href;
    }
  } catch {
    return { url, status: null, location: null, redirects };
  } finally {
    clearTimeout(timer);
  }
}

/** GETs a URL once without following redirects and discards the body. Never throws. */
export async function probeStatus(
  url: string,
  options: { timeoutMs?: number } = {},
): Promise<StatusProbe> {
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS),
      headers: { 'user-agent': USER_AGENT },
    });
    await response.body?.cancel().catch(() => undefined);
    return { url, status: response.status };
  } catch {
    return { url, status: null };
  }
}

export const TLS_TIMEOUT_MS = 5_000;

/**
 * Completes a TLS handshake with `host:port` and reads the certificate and protocol; no HTTP
 * request is sent. The chain is checked against Node's built-in CA store (missing intermediates
 * are not fetched), but a bad certificate is reported rather than rejected. Never throws.
 */
export function probeTls(
  host: string,
  port = 443,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<TlsProbe> {
  const bare = host.replace(/^\[|\]$/g, '');
  const failed = (error: string): TlsProbe => ({
    host: bare,
    port,
    error,
    authorized: false,
    authorizationError: null,
    protocol: null,
    validTo: null,
  });
  return new Promise((resolve) => {
    let socket: TLSSocket | undefined;
    let settled = false;
    const finish = (probe: TlsProbe) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      socket?.destroy();
      resolve(probe);
    };
    const onAbort = () => finish(failed('aborted'));
    const timer = setTimeout(
      () => finish(failed(`timed out after ${options.timeoutMs ?? TLS_TIMEOUT_MS} ms`)),
      options.timeoutMs ?? TLS_TIMEOUT_MS,
    );
    if (options.signal?.aborted) return onAbort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      socket = connect({
        host: bare,
        port,
        // SNI must be a hostname; Node warns when it is an IP address.
        ...(isIP(bare) === 0 && { servername: bare }),
        rejectUnauthorized: false,
        minVersion: 'TLSv1',
        // OpenSSL's default security level refuses TLS 1.0/1.1 even with minVersion, which would
        // turn an outdated server into a handshake error instead of a protocol we can report.
        ciphers: 'DEFAULT:@SECLEVEL=0',
      });
    } catch (err) {
      return finish(failed(describeCause(err)));
    }
    socket.once('secureConnect', () => {
      const cert = socket!.getPeerCertificate();
      const authError = socket!.authorizationError;
      finish({
        host: bare,
        port,
        error: null,
        authorized: socket!.authorized,
        authorizationError: socket!.authorized ? null : String(authError),
        protocol: socket!.getProtocol(),
        validTo: cert && cert.valid_to ? new Date(cert.valid_to).toISOString() : null,
      });
    });
    socket.once('error', (err) => finish(failed(describeCause(err))));
  });
}
