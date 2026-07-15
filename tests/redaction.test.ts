/**
 * No token in logs: every output path funnels through redact(), and Graph error
 * messages are redacted before they become a GraphHttpError. A leaked bearer
 * token or private key must never reach stdout/stderr.
 */

import { afterEach, expect, test } from "bun:test";
import { Graph, usersPath } from "../src/graph.ts";
import { printJson, redact } from "../src/output.ts";
import { installMockFetch, type MockHandle, TEST_CONFIG } from "./helpers/mockFetch.ts";

const SAMPLE_JWT =
  "eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

const SAMPLE_KEY =
  "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcw\n-----END PRIVATE KEY-----";

const SAMPLE_ENCRYPTED_KEY =
  "-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIFDjBABgkqhkiG9w0BBQ0wMzAbBgkqhkiG\n-----END ENCRYPTED PRIVATE KEY-----";

let handle: MockHandle | undefined;
afterEach(() => handle?.restore());

test("redact scrubs bearer tokens, raw JWTs, and PEM private keys", () => {
  expect(redact(`Authorization: Bearer ${SAMPLE_JWT}`)).not.toContain(SAMPLE_JWT);
  expect(redact(`Authorization: Bearer ${SAMPLE_JWT}`)).toContain("Bearer <redacted>");

  expect(redact(`token=${SAMPLE_JWT}`)).toContain("<redacted-jwt>");
  expect(redact(`token=${SAMPLE_JWT}`)).not.toContain(SAMPLE_JWT);

  const red = redact(`key is ${SAMPLE_KEY}`);
  expect(red).toContain("<redacted-private-key>");
  expect(red).not.toContain("MIIEvQIBAD");
});

test("redact scrubs non-standard PEM key types too (e.g. ENCRYPTED PRIVATE KEY)", () => {
  const red = redact(`key is ${SAMPLE_ENCRYPTED_KEY}`);
  expect(red).toContain("<redacted-private-key>");
  expect(red).not.toContain("MIIFDjBABgkqhkiG9w0BBQ0w");
});

test("printJson output is redacted", () => {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => {
    chunks.push(String(s));
    return true;
  }) as typeof process.stdout.write;
  try {
    printJson({ ok: true, leaked: `Bearer ${SAMPLE_JWT}`, note: SAMPLE_JWT });
  } finally {
    process.stdout.write = orig;
  }
  const out = chunks.join("");
  expect(out).not.toContain(SAMPLE_JWT);
});

test("Graph error messages are redacted before surfacing", async () => {
  // A hostile/echoing server that reflects the auth header into the error text.
  handle = installMockFetch([
    {
      method: "GET",
      match: (u) => u.includes("/messages"),
      status: 401,
      json: { error: { code: "InvalidAuthenticationToken", message: `Bad token: Bearer ${SAMPLE_JWT}` } },
    },
  ]);
  const graph = Graph.withToken(SAMPLE_JWT, { ...TEST_CONFIG });
  let msg = "";
  try {
    await graph.get(usersPath(TEST_CONFIG.mailbox, "messages"));
  } catch (e) {
    msg = e instanceof Error ? e.message : String(e);
  }
  expect(msg).not.toContain(SAMPLE_JWT);
  expect(msg.length).toBeGreaterThan(0);
});
