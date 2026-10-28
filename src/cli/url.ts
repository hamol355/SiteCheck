export class InvalidUrlError extends Error {
  override name = 'InvalidUrlError';
}

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Trims the input and assumes https:// when no scheme is given. Only http(s) URLs are accepted. */
export function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed === '') throw new InvalidUrlError('URL must not be empty');
  // Test for "://" rather than parsing first: new URL('localhost:1') reads "localhost:" as a scheme.
  const candidate = HAS_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new InvalidUrlError(`Invalid URL: ${input}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new InvalidUrlError(`Unsupported protocol ${url.protocol} (only http and https)`);
  }
  // fetch refuses such URLs, and echoing the input would print the password.
  if (url.username !== '' || url.password !== '') {
    throw new InvalidUrlError('URLs with a username or password are not supported');
  }
  return url.href;
}
