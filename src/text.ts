/** Longest untrusted value quoted in a message before it is cut off. */
export const MAX_QUOTED_LENGTH = 100;

// C0 and C1 control characters plus DEL; ESC in particular starts terminal escape sequences.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/** Replaces control characters with visible \xNN escapes so they cannot drive a terminal. */
export function escapeControlChars(text: string): string {
  return text.replace(
    CONTROL_CHARS,
    (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, '0')}`,
  );
}

/**
 * Makes a value fetched from the site (header, attribute, Location) safe to put in a message:
 * control characters are escaped and long values are cut to `max` characters.
 */
export function quoteUntrusted(value: string, max = MAX_QUOTED_LENGTH): string {
  const shortened = value.length > max ? `${value.slice(0, max)}…` : value;
  return escapeControlChars(shortened);
}
