/**
 * Config capability invariants: read is always on and free; every other
 * capability (markRead, download, move, send, reply, forward) is an
 * independent, deny-by-default toggle. The allowlist is required if and only
 * if send, reply, OR forward is enabled — a read-only identity must never be
 * forced to configure one.
 */

import { expect, test } from "bun:test";
import { validateConfig } from "../src/config.ts";

const BASE = {
  tenantId: "contoso.onmicrosoft.com",
  clientId: "11111111-2222-3333-4444-555555555555",
  mailbox: "agent@contoso.com",
};

const ALL_OFF = { markRead: false, download: false, move: false, send: false, reply: false, forward: false };

test("validateConfig defaults every capability to false when capabilities is omitted", () => {
  const cfg = validateConfig({ ...BASE });
  expect(cfg.capabilities).toEqual(ALL_OFF);
  expect(cfg.allowlistGroup).toBeUndefined();
});

test("validateConfig requires allowlistGroup when send is true", () => {
  expect(() => validateConfig({ ...BASE, capabilities: { send: true } })).toThrow(/allowlistGroup/);
});

test("validateConfig requires allowlistGroup when only reply is true (not just send)", () => {
  expect(() => validateConfig({ ...BASE, capabilities: { reply: true } })).toThrow(/allowlistGroup/);
});

test("validateConfig requires allowlistGroup when only forward is true", () => {
  expect(() => validateConfig({ ...BASE, capabilities: { forward: true } })).toThrow(/allowlistGroup/);
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

test("validateConfig does not require allowlistGroup for move, markRead, or download alone", () => {
  const cfg = validateConfig({ ...BASE, capabilities: { move: true, markRead: true, download: true } });
  expect(cfg.capabilities).toEqual({ ...ALL_OFF, move: true, markRead: true, download: true });
  expect(cfg.allowlistGroup).toBeUndefined();
});

test("validateConfig keeps reply/forward independent of send", () => {
  const cfg = validateConfig({
    ...BASE,
    capabilities: { reply: true },
    allowlistGroup: "emissary-allowed@contoso.com",
  });
  expect(cfg.capabilities.send).toBe(false);
  expect(cfg.capabilities.reply).toBe(true);
  expect(cfg.capabilities.forward).toBe(false);
});
