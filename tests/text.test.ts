import { describe, expect, it } from 'vitest';
import { escapeControlChars, MAX_QUOTED_LENGTH, quoteUntrusted } from '../src/text.js';

describe('escapeControlChars', () => {
  it('escapes ESC, newlines and C1 controls but keeps other text', () => {
    expect(escapeControlChars('a\u001b[31mb\nc\u009bd')).toBe('a\\x1b[31mb\\x0ac\\x9bd');
    expect(escapeControlChars('åäö – ok')).toBe('åäö – ok');
  });
});

describe('quoteUntrusted', () => {
  it('leaves short values unchanged', () => {
    expect(quoteUntrusted('sv-SE')).toBe('sv-SE');
  });

  it('cuts long values off', () => {
    const quoted = quoteUntrusted('x'.repeat(MAX_QUOTED_LENGTH + 50));
    expect(quoted).toBe(`${'x'.repeat(MAX_QUOTED_LENGTH)}…`);
  });

  it('escapes control characters', () => {
    expect(quoteUntrusted('en\u001b[2J')).toBe('en\\x1b[2J');
  });
});
