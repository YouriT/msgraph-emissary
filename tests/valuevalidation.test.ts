/**
 * flag/importance/focus reject an invalid enum value up front, before ever
 * loading config or touching Graph — same "fail fast, no network" pattern as
 * the capability gates. No XDG setup needed here since these commands never
 * get that far when the value itself is invalid.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { flagCommand } from "../src/commands/flag.ts";
import { focusCommand } from "../src/commands/focus.ts";
import { importanceCommand } from "../src/commands/importance.ts";

let chunks: string[];
let origWrite: typeof process.stdout.write;

beforeEach(() => {
  chunks = [];
  origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => {
    chunks.push(String(s));
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  process.stdout.write = origWrite;
});

test("flag rejects an invalid --status before touching config/Graph", async () => {
  const code = await flagCommand(["abc123", "--status", "urgent"]);
  expect(code).toBe(1);
  expect(chunks.join("")).toContain("invalid");
});

test("importance rejects an invalid --level before touching config/Graph", async () => {
  const code = await importanceCommand(["abc123", "--level", "urgent"]);
  expect(code).toBe(1);
  expect(chunks.join("")).toContain("invalid");
});

test("focus rejects an invalid --as before touching config/Graph", async () => {
  const code = await focusCommand(["abc123", "--as", "important"]);
  expect(code).toBe(1);
  expect(chunks.join("")).toContain("invalid");
});
