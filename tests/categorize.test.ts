/**
 * categorize.ts's add/remove merge: Graph has no atomic add/remove for a
 * message's categories (PATCH replaces the whole array), so we compute the
 * new set client-side. Covers ordering-independence, add-and-remove-together,
 * removing something not present, and adding a duplicate.
 */

import { expect, test } from "bun:test";
import { applyCategoryChanges } from "../src/commands/categorize.ts";

test("adds new categories to an empty list", () => {
  expect(applyCategoryChanges([], ["Red"], [])).toEqual(["Red"]);
});

test("removes an existing category", () => {
  expect(applyCategoryChanges(["Red", "Blue"], [], ["Red"])).toEqual(["Blue"]);
});

test("add and remove in the same call: remove applies before add for the same name", () => {
  // A name in both --remove and --add ends up present (add wins), matching
  // "the caller's final --add intent always sticks."
  expect(applyCategoryChanges(["Red"], ["Red"], ["Red"])).toEqual(["Red"]);
});

test("removing a category that isn't present is a no-op, not an error", () => {
  expect(applyCategoryChanges(["Blue"], [], ["Green"])).toEqual(["Blue"]);
});

test("adding a category that's already present does not duplicate it", () => {
  expect(applyCategoryChanges(["Red"], ["Red"], [])).toEqual(["Red"]);
});

test("unrelated existing categories are preserved", () => {
  const result = applyCategoryChanges(["Keep", "Red"], ["Blue"], ["Red"]);
  expect(new Set(result)).toEqual(new Set(["Keep", "Blue"]));
});
