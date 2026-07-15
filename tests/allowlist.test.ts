/**
 * Allowlist: the outbound preflight must ALLOW group members and REFUSE
 * everyone else. Covers both the pure preflight logic and resolveAllowlist over
 * a mocked Graph.
 */

import { afterEach, expect, test } from "bun:test";
import { normalizeAddress, preflight, resolveAllowlist } from "../src/allowlist.ts";
import { Graph } from "../src/graph.ts";
import { installMockFetch, type MockHandle, TEST_CONFIG } from "./helpers/mockFetch.ts";

let handle: MockHandle | undefined;
afterEach(() => handle?.restore());

function mockGroupWith(members: unknown[]): MockHandle {
  return installMockFetch([
    {
      method: "GET",
      match: (u) => u.includes("/groups?"),
      json: { value: [{ id: "grp1", displayName: "Allowed" }] },
    },
    {
      method: "GET",
      match: (u) => u.includes("/groups/grp1/transitiveMembers"),
      json: { value: members },
    },
  ]);
}

test("resolveAllowlist indexes member emails and preflight allows a member", async () => {
  handle = mockGroupWith([
    { id: "u1", "@odata.type": "#microsoft.graph.user", displayName: "Ok User", mail: "ok@contoso.com" },
    {
      id: "c1",
      "@odata.type": "#microsoft.graph.orgContact",
      displayName: "Partner",
      mail: "partner@example.com",
    },
  ]);
  const graph = Graph.withToken("test-token", { ...TEST_CONFIG });
  const resolved = await resolveAllowlist(graph, TEST_CONFIG.allowlistGroup);

  expect(resolved.members.length).toBe(2);
  expect(resolved.emails.has("ok@contoso.com")).toBe(true);

  const pf = preflight(["ok@contoso.com"], resolved);
  expect(pf.ok).toBe(true);
  expect(pf.blocked).toEqual([]);
});

test("preflight REFUSES a non-member (case-insensitive, name<addr> form)", async () => {
  handle = mockGroupWith([{ id: "u1", "@odata.type": "#microsoft.graph.user", mail: "ok@contoso.com" }]);
  const graph = Graph.withToken("test-token", { ...TEST_CONFIG });
  const resolved = await resolveAllowlist(graph, TEST_CONFIG.allowlistGroup);

  // Member match is case-insensitive and tolerates "Name <addr>".
  expect(preflight(["OK@Contoso.com"], resolved).ok).toBe(true);
  expect(preflight(["Ok User <ok@contoso.com>"], resolved).ok).toBe(true);

  // A stranger is blocked, and a mixed batch fails as a whole.
  const blocked = preflight(["evil@attacker.test"], resolved);
  expect(blocked.ok).toBe(false);
  expect(blocked.blocked).toEqual(["evil@attacker.test"]);

  const mixed = preflight(["ok@contoso.com", "evil@attacker.test"], resolved);
  expect(mixed.ok).toBe(false);
  expect(mixed.blocked).toEqual(["evil@attacker.test"]);
});

test("normalizeAddress extracts the bare address", () => {
  expect(normalizeAddress("Jane Doe <jane@x.com>")).toBe("jane@x.com");
  expect(normalizeAddress("  BOB@X.com ")).toBe("bob@x.com");
});
