/**
 * Message-id resolution: an exact id always wins; an ambiguous suffix must ERROR
 * rather than silently pick the first hit (a predecessor bug).
 */

import { afterEach, expect, test } from "bun:test";
import { Graph } from "../src/graph.ts";
import { AmbiguousIdError, matchIdSuffix, resolveMessageId } from "../src/mail.ts";
import { installMockFetch, type MockHandle, TEST_CONFIG } from "./helpers/mockFetch.ts";

let handle: MockHandle | undefined;
afterEach(() => handle?.restore());

test("matchIdSuffix: exact id wins even if it is also a suffix of another", () => {
  const ids = ["AAA111", "ZZAAA111"];
  const r = matchIdSuffix(ids, "AAA111");
  expect(r.kind).toBe("exact");
  expect(r.id).toBe("AAA111");
});

test("matchIdSuffix: unique suffix resolves", () => {
  const r = matchIdSuffix(["longid_ABC", "longid_XYZ"], "ABC");
  expect(r.kind).toBe("unique");
  expect(r.id).toBe("longid_ABC");
});

test("matchIdSuffix: ambiguous suffix does NOT guess", () => {
  const r = matchIdSuffix(["one_TAIL", "two_TAIL"], "TAIL");
  expect(r.kind).toBe("ambiguous");
  expect(r.matches).toEqual(["one_TAIL", "two_TAIL"]);
});

test("matchIdSuffix: no match", () => {
  expect(matchIdSuffix(["a", "b"], "zzz").kind).toBe("none");
});

test("resolveMessageId: exact GET hit returns the id without listing", async () => {
  handle = installMockFetch([
    {
      method: "GET",
      match: (u) => u.includes("/messages/FULLID"),
      json: { id: "FULLID" },
    },
  ]);
  const graph = Graph.withToken("t", { ...TEST_CONFIG });
  expect(await resolveMessageId(graph, TEST_CONFIG, "FULLID")).toBe("FULLID");
});

test("resolveMessageId: ambiguous suffix throws AmbiguousIdError", async () => {
  handle = installMockFetch([
    // exact lookup misses -> 404 (path has "/messages/TAIL")
    {
      method: "GET",
      match: (u) => u.includes("/messages/TAIL"),
      status: 404,
      json: { error: { code: "ErrorItemNotFound" } },
    },
    // recent listing returns two ids ending in TAIL (path has "/messages?")
    {
      method: "GET",
      match: (u) => u.includes("/messages?"),
      json: { value: [{ id: "one_TAIL" }, { id: "two_TAIL" }] },
    },
  ]);
  const graph = Graph.withToken("t", { ...TEST_CONFIG });
  await expect(resolveMessageId(graph, TEST_CONFIG, "TAIL")).rejects.toThrow(AmbiguousIdError);
});
