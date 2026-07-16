/**
 * List-filter query building: the pure OData/KQL clause helpers, plus an
 * integration check (against a mocked Graph) that listMessages sends the
 * exact query string a given combination of filters should produce — this
 * is the kind of thing types can't catch (a subtly wrong $filter string
 * still typechecks fine and just silently returns the wrong messages).
 */

import { afterEach, expect, test } from "bun:test";
import { Graph } from "../src/graph.ts";
import { categoryFilterClause, kqlEscape, kqlImportance, listMessages, odataQuote } from "../src/mail.ts";
import { installMockFetch, type MockHandle, TEST_CONFIG } from "./helpers/mockFetch.ts";

let handle: MockHandle | undefined;
afterEach(() => handle?.restore());

test("odataQuote doubles embedded single quotes (OData string-literal escaping)", () => {
  expect(odataQuote("Red")).toBe("'Red'");
  expect(odataQuote("O'Brien")).toBe("'O''Brien'");
});

test("categoryFilterClause ORs multiple categories, never ANDs (Graph silently returns nothing on AND)", () => {
  expect(categoryFilterClause(["Red"])).toBe("categories/any(a:a eq 'Red')");
  expect(categoryFilterClause(["Red", "Blue"])).toBe(
    "categories/any(a:a eq 'Red') or categories/any(a:a eq 'Blue')",
  );
});

test("kqlEscape backslash-escapes quotes and backslashes per Graph's $search rule", () => {
  expect(kqlEscape('say "hi"')).toBe('say \\"hi\\"');
  expect(kqlEscape("C:\\path")).toBe("C:\\\\path");
});

test("kqlImportance maps normal -> medium (KQL's own enum differs from the message property's)", () => {
  expect(kqlImportance("low")).toBe("low");
  expect(kqlImportance("normal")).toBe("medium");
  expect(kqlImportance("high")).toBe("high");
});

test("listMessages ($filter mode) ANDs unreadOnly + from + hasAttachments + importance + categories", async () => {
  handle = installMockFetch([{ method: "GET", match: () => true, json: { value: [] } }]);
  const graph = Graph.withToken("t", { ...TEST_CONFIG });
  await listMessages(graph, TEST_CONFIG, {
    unreadOnly: true,
    from: "a@b.com",
    hasAttachments: true,
    importance: "high",
    categories: ["Red", "Blue"],
  });
  const url = decodeURIComponent(handle.requests[0]!.url.replace(/\+/g, " "));
  expect(url).toContain(
    "$filter=isRead eq false and from/emailAddress/address eq 'a@b.com' and hasAttachments eq true " +
      "and importance eq 'high' and (categories/any(a:a eq 'Red') or categories/any(a:a eq 'Blue'))",
  );
});

test("listMessages ($search mode) ANDs the query with from/hasAttachments/importance as KQL clauses", async () => {
  handle = installMockFetch([{ method: "GET", match: () => true, json: { value: [] } }]);
  const graph = Graph.withToken("t", { ...TEST_CONFIG });
  await listMessages(graph, TEST_CONFIG, {
    search: "invoice",
    from: "a@b.com",
    hasAttachments: true,
    importance: "normal",
  });
  const url = decodeURIComponent(handle.requests[0]!.url.replace(/\+/g, " "));
  expect(url).toContain(
    '$search="invoice" AND "from:a@b.com" AND "hasAttachments:true" AND "importance:medium"',
  );
});

test("listMessages ($search mode) applies --category client-side, since KQL can't search it", async () => {
  handle = installMockFetch([
    {
      method: "GET",
      match: () => true,
      json: {
        value: [
          { id: "m1", categories: ["Red"] },
          { id: "m2", categories: ["Blue"] },
          { id: "m3", categories: [] },
        ],
      },
    },
  ]);
  const graph = Graph.withToken("t", { ...TEST_CONFIG });
  const result = await listMessages(graph, TEST_CONFIG, { search: "invoice", categories: ["Red"] });
  expect(result.messages.map((m) => m.id)).toEqual(["m1"]);
  // The server never saw a $filter — Graph would reject $search + $filter together.
  expect(handle.requests[0]!.url).not.toContain("$filter");
});

// --------------------------------------------------------------------------
// Pagination: --top caps a single page, but a real "1000 messages" request
// (the bug an agent actually hit) must be satisfiable by following nextLink
// across explicit, agent-driven calls — not silently truncated with no way
// to get the rest.
// --------------------------------------------------------------------------

const NEXT_LINK = "https://graph.microsoft.com/v1.0/users/agent%40contoso.com/messages?$skip=100";

test("listMessages ($filter mode) returns nextLink when Graph says there's more", async () => {
  handle = installMockFetch([
    {
      method: "GET",
      match: (u) => !u.includes("$skip"),
      json: { value: [{ id: "m1" }], "@odata.nextLink": NEXT_LINK },
    },
  ]);
  const graph = Graph.withToken("t", { ...TEST_CONFIG });
  const result = await listMessages(graph, TEST_CONFIG, { top: 1 });
  expect(result.nextLink).toBe(NEXT_LINK);
});

test("listMessages omits nextLink entirely when Graph has no more pages (not nextLink: undefined)", async () => {
  handle = installMockFetch([{ method: "GET", match: () => true, json: { value: [{ id: "m1" }] } }]);
  const graph = Graph.withToken("t", { ...TEST_CONFIG });
  const result = await listMessages(graph, TEST_CONFIG, {});
  expect("nextLink" in result).toBe(false);
});

test("listMessages({ next }) fetches the supplied nextLink directly, ignoring other options", async () => {
  handle = installMockFetch([
    {
      method: "GET",
      match: (u) => u === NEXT_LINK,
      json: { value: [{ id: "m2" }] },
    },
  ]);
  const graph = Graph.withToken("t", { ...TEST_CONFIG });
  const result = await listMessages(graph, TEST_CONFIG, {
    next: NEXT_LINK,
    // These would build a completely different request if `next` weren't honored first.
    folder: "archive",
    unreadOnly: true,
    top: 5,
  });
  expect(result.messages.map((m) => m.id)).toEqual(["m2"]);
  expect(handle.requests.length).toBe(1);
  expect(handle.requests[0]!.url).toBe(NEXT_LINK);
});

test("listMessages({ next, categories }) still re-applies the client-side category filter per page", async () => {
  handle = installMockFetch([
    {
      method: "GET",
      match: (u) => u === NEXT_LINK,
      json: {
        value: [
          { id: "m2", categories: ["Blue"] },
          { id: "m3", categories: ["Red"] },
        ],
      },
    },
  ]);
  const graph = Graph.withToken("t", { ...TEST_CONFIG });
  const result = await listMessages(graph, TEST_CONFIG, { next: NEXT_LINK, categories: ["Red"] });
  expect(result.messages.map((m) => m.id)).toEqual(["m3"]);
});
