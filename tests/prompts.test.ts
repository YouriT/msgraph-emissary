/**
 * `init`'s interactive prompts must re-ask on a blank/invalid answer instead
 * of letting it flow through to validateConfig() and crash the whole wizard
 * after the operator has already typed tenant/client/mailbox (a real bug:
 * hitting Enter on "Allowlist group address" used to blow up onboarding with
 * a raw JSON error and no way to just answer again).
 */

import { expect, test } from "bun:test";
import { type Asker, askRequired, askRequiredEmail, askYesNo } from "../src/commands/init.ts";

function fakeAsker(answers: string[]): Asker {
  let i = 0;
  return {
    question: async () => {
      const a = answers[i];
      i++;
      return a ?? "";
    },
  };
}

test("askRequired re-prompts on blank input instead of accepting it", async () => {
  const rl = fakeAsker(["", "   ", "a82ba86d-82be-4dce-8a88-6d11f120f2ba"]);
  const answer = await askRequired(rl, "Entra tenant ID");
  expect(answer).toBe("a82ba86d-82be-4dce-8a88-6d11f120f2ba");
});

test("askRequiredEmail re-prompts on blank AND on non-email input", async () => {
  const rl = fakeAsker(["", "not-an-email", "emissary-allowed@contoso.com"]);
  const answer = await askRequiredEmail(rl, "Allowlist group address");
  expect(answer).toBe("emissary-allowed@contoso.com");
});

test("askYesNo: empty input takes the default, y/n are parsed, invalid input re-prompts", async () => {
  const rl = fakeAsker(["", "Y", "n", "nope", "y"]);
  expect(await askYesNo(rl, "Allow moving messages?", false)).toBe(false); // "" -> default
  expect(await askYesNo(rl, "Allow moving messages?", false)).toBe(true); // "Y"
  expect(await askYesNo(rl, "Allow sending mail?", true)).toBe(false); // "n"
  expect(await askYesNo(rl, "Allow sending mail?", false)).toBe(true); // "nope" (invalid) then "y"
});
