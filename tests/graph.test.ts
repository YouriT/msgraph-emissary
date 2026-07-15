/**
 * Graph client hardening: `paged()` must never follow a server-supplied
 * @odata.nextLink to a non-Graph host, since it would carry the bearer token.
 */

import { afterEach, expect, test } from "bun:test";
import { Graph, usersPath } from "../src/graph.ts";
import { installMockFetch, type MockHandle, TEST_CONFIG } from "./helpers/mockFetch.ts";

let handle: MockHandle | undefined;
afterEach(() => handle?.restore());

test("paged() follows a same-host nextLink", async () => {
  handle = installMockFetch([
    {
      method: "GET",
      match: (u) => u.includes("/messages?") && !u.includes("page2"),
      json: {
        value: [{ id: "m1" }],
        "@odata.nextLink": "https://graph.microsoft.com/v1.0/users/agent%40contoso.com/messages?page2",
      },
    },
    {
      method: "GET",
      match: (u) => u.includes("page2"),
      json: { value: [{ id: "m2" }] },
    },
  ]);
  const graph = Graph.withToken("t", { ...TEST_CONFIG });
  const items = await graph.paged(usersPath(TEST_CONFIG.mailbox, "messages"), { $top: 1 }, 10);
  expect(items.length).toBe(2);
});

test("paged() refuses to follow a nextLink pointing off Graph (token exfiltration guard)", async () => {
  handle = installMockFetch([
    {
      method: "GET",
      match: (u) => u.includes("/messages?"),
      json: {
        value: [{ id: "m1" }],
        "@odata.nextLink": "https://evil.attacker.test/steal?page2",
      },
    },
  ]);
  const graph = Graph.withToken("secret-token", { ...TEST_CONFIG });
  await expect(graph.paged(usersPath(TEST_CONFIG.mailbox, "messages"), { $top: 1 }, 10)).rejects.toThrow(
    /non-Graph/,
  );
  // The malicious host must never have been contacted.
  expect(handle.requests.some((r) => r.url.includes("evil.attacker.test"))).toBe(false);
});
