/**
 * Agent-facing output helpers.
 *
 * Everything Emissary prints goes through here so we can guarantee two things:
 *   1. Output is compact JSON an agent can parse (numbered results, short id
 *      suffixes for readability while keeping the full id available).
 *   2. Secrets never leak: `redact()` scrubs anything that looks like a bearer
 *      token or PEM private key before it can reach stdout/stderr.
 *
 * There is deliberately NO `token get` command and nothing here prints a token.
 */

import type { ErrorResult } from "./types.ts";

/**
 * Scrub secret-looking substrings from any text before printing. Defense in
 * depth: even if a Graph error echoed an Authorization header, or an exception
 * carried a JWT, it never reaches the terminal in the clear.
 */
export function redact(text: string): string {
  return (
    text
      // Bearer tokens (JWTs are three base64url segments separated by dots)
      .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer <redacted>")
      .replace(/\beyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/g, "<redacted-jwt>")
      // PEM private key blocks — any variant (PRIVATE KEY, RSA/EC PRIVATE KEY,
      // ENCRYPTED PRIVATE KEY, ...), matched generically so a PEM type we don't
      // currently emit still gets scrubbed if it ever appears.
      .replace(
        /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
        "<redacted-private-key>",
      )
  );
}

/** Print a value as compact JSON to stdout, redacted. */
export function printJson(value: unknown): void {
  process.stdout.write(`${redact(JSON.stringify(value))}\n`);
}

/** Print a value as pretty JSON to stdout, redacted (used by wizard/doctor summaries). */
export function printPrettyJson(value: unknown): void {
  process.stdout.write(`${redact(JSON.stringify(value, null, 2))}\n`);
}

/** Print a human line to stderr (progress/prompts), redacted. Keeps stdout pure JSON. */
export function printErrLine(text: string): void {
  process.stderr.write(`${redact(text)}\n`);
}

/** Build (do not print) a uniform error result. */
export function errorResult(error: string, detail?: string): ErrorResult {
  return detail === undefined ? { ok: false, error } : { ok: false, error, detail };
}

/**
 * A short, human-scannable suffix of a Graph id. Graph message ids are long
 * base64-ish blobs; the last 12 chars are plenty to eyeball while the full id
 * stays in the `id` field for exact operations.
 */
export function shortId(id: string): string {
  const tail = id.length > 12 ? id.slice(-12) : id;
  return tail;
}

/**
 * Attach a stable 1-based index and a short id to each row of a result set,
 * matching the predecessor's numbered-results convention.
 */
export function numbered<T extends { id: string }>(rows: T[]): Array<T & { n: number; short: string }> {
  return rows.map((row, i) => ({ ...row, n: i + 1, short: shortId(row.id) }));
}
