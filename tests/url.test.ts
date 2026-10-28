import { describe, expect, it } from 'vitest';
import { InvalidUrlError, normalizeUrl } from '../src/cli/url.js';

describe('normalizeUrl', () => {
  it('assumes https when the scheme is missing', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com/');
  });

  it('keeps an explicit http or https scheme', () => {
    expect(normalizeUrl('http://example.com')).toBe('http://example.com/');
    expect(normalizeUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
  });

  it('trims whitespace', () => {
    expect(normalizeUrl('  example.com  ')).toBe('https://example.com/');
  });

  it('does not read host:port as a scheme', () => {
    expect(normalizeUrl('localhost:1')).toBe('https://localhost:1/');
    expect(normalizeUrl('localhost:3000/path')).toBe('https://localhost:3000/path');
  });

  it('rejects empty input', () => {
    expect(() => normalizeUrl('   ')).toThrow(InvalidUrlError);
  });

  it('rejects unsupported protocols', () => {
    expect(() => normalizeUrl('ftp://example.com')).toThrow(InvalidUrlError);
    expect(() => normalizeUrl('file:///etc/passwd')).toThrow(InvalidUrlError);
  });

  it('rejects credentials without echoing them', () => {
    for (const input of ['https://user:secret@example.com', 'user:secret@example.com']) {
      expect(() => normalizeUrl(input)).toThrow(InvalidUrlError);
      expect(() => normalizeUrl(input)).toThrow(
        'URLs with a username or password are not supported',
      );
    }
  });

  it('rejects unparseable URLs', () => {
    expect(() => normalizeUrl('http://')).toThrow(InvalidUrlError);
    expect(() => normalizeUrl('exa mple.com')).toThrow(InvalidUrlError);
  });
});
