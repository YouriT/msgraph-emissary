/**
 * Filename sanitization + untrusted-body rendering.
 * These guard the attachment-download path-traversal/overwrite bugs and ensure
 * email bodies carry the prompt-injection notice.
 */

import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INJECTION_NOTICE,
  renderBody,
  safeBasename,
  safeDestination,
  stripHtml,
  UnsafeFilenameError,
} from "../src/sanitize.ts";

test("safeBasename strips path separators to a bare name", () => {
  expect(safeBasename("report.pdf")).toBe("report.pdf");
  expect(safeBasename("/etc/passwd")).toBe("passwd");
  expect(safeBasename("sub/dir/file.txt")).toBe("file.txt");
});

test("safeBasename rejects traversal and empty names", () => {
  expect(() => safeBasename("..")).toThrow(UnsafeFilenameError);
  expect(() => safeBasename("../../etc/passwd")).toThrow(UnsafeFilenameError);
  expect(() => safeBasename("foo/../bar")).toThrow(UnsafeFilenameError);
  expect(() => safeBasename("")).toThrow(UnsafeFilenameError);
});

test("safeBasename neutralizes leading-dash (option injection) names", () => {
  expect(safeBasename("--rf")).toBe("_rf");
});

test("safeDestination refuses to escape the output dir", async () => {
  const out = join(tmpdir(), "emissary-test-out");
  await expect(safeDestination(out, "../escape.txt")).rejects.toThrow(UnsafeFilenameError);
});

test("safeDestination refuses to overwrite an existing file", async () => {
  const out = join(tmpdir(), `emissary-test-${process.pid}`);
  const name = "exists.txt";
  await Bun.write(join(out, name), "already here");
  await expect(safeDestination(out, name)).rejects.toThrow(/overwrite/);
  // A fresh name is fine.
  await expect(safeDestination(out, "fresh.txt")).resolves.toContain("fresh.txt");
});

test("stripHtml removes tags and scripts", () => {
  const html = "<p>Hi <b>there</b></p><script>steal()</script>";
  const out = stripHtml(html);
  expect(out).not.toContain("<");
  expect(out).not.toContain("steal()");
  expect(out).toContain("Hi");
});

test("renderBody prepends the injection notice and truncates", () => {
  const big = "x".repeat(10_000);
  const r = renderBody(big, "text");
  expect(r.notice).toBe(INJECTION_NOTICE);
  expect(r.truncated).toBe(true);
  expect(r.content.length).toBeLessThan(big.length);
});
