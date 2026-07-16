/**
 * Graph client hardening: `paged()`/`followLink()` must never follow a
 * server-supplied @odata.nextLink to a non-Graph host, since it would carry
 * the bearer token.
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

test("followLink() fetches exactly the given URL and returns the raw collection (value + nextLink)", async () => {
  const link = "https://graph.microsoft.com/v1.0/users/agent%40contoso.com/messages?$skip=100";
  handle = installMockFetch([
    { method: "GET", match: (u) => u === link, json: { value: [{ id: "m2" }], "@odata.nextLink": "next2" } },
  ]);
  const graph = Graph.withToken("t", { ...TEST_CONFIG });
  const page = await graph.followLink(link);
  expect(page.value).toEqual([{ id: "m2" }]);
  expect(page["@odata.nextLink"]).toBe("next2");
});

test("followLink() refuses a non-Graph URL (same token-exfiltration guard as paged())", async () => {
  const graph = Graph.withToken("secret-token", { ...TEST_CONFIG });
  await expect(graph.followLink("https://evil.attacker.test/steal")).rejects.toThrow(/non-Graph/);
});

test("followLink() sends caller headers, but they can never override Authorization", async () => {
  const link = "https://graph.microsoft.com/v1.0/users/agent%40contoso.com/messages?$skip=100";
  handle = installMockFetch([{ method: "GET", match: (u) => u === link, json: { value: [] } }]);
  const graph = Graph.withToken("real-token", { ...TEST_CONFIG });
  await graph.followLink(link, { ConsistencyLevel: "eventual", Authorization: "Bearer attacker-supplied" });
  const sent = handle.requests[0]!.headers;
  expect(sent.ConsistencyLevel).toBe("eventual");
  expect(sent.Authorization).toBe("Bearer real-token");
});
