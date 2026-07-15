/**
 * Config capability invariants: read is always on and free; move/send are
 * opt-in; the allowlist is required if and only if send is enabled — a
 * read-only identity must never be forced to configure one.
 */

import { expect, test } from "bun:test";
import { validateConfig } from "../src/config.ts";

const BASE = {
  tenantId: "contoso.onmicrosoft.com",
  clientId: "11111111-2222-3333-4444-555555555555",
  mailbox: "agent@contoso.com",
};

test("validateConfig defaults to read-only when capabilities is omitted", () => {
  const cfg = validateConfig({ ...BASE });
  expect(cfg.capabilities).toEqual({ move: false, send: false });
  expect(cfg.allowlistGroup).toBeUndefined();
});

test("validateConfig requires allowlistGroup when capabilities.send is true", () => {
  expect(() => validateConfig({ ...BASE, capabilities: { send: true } })).toThrow(/allowlistGroup/);
});

test("validateConfig accepts send:true with an allowlistGroup", () => {
  const cfg = validateConfig({
    ...BASE,
    capabilities: { send: true },
    allowlistGroup: "emissary-allowed@contoso.com",
  });
  expect(cfg.capabilities.send).toBe(true);
  expect(cfg.allowlistGroup).toBe("emissary-allowed@contoso.com");
});

test("validateConfig does not require allowlistGroup when send is false, even if move is true", () => {
  const cfg = validateConfig({ ...BASE, capabilities: { move: true, send: false } });
  expect(cfg.capabilities).toEqual({ move: true, send: false });
  expect(cfg.allowlistGroup).toBeUndefined();
});
