/**
 * Regression test: render.ts's CAPABILITY_ORDER (used for the admin-pack
 * summary and the Graph-role/permission derivation) must list every key of
 * Capabilities. It's a manually-maintained array parallel to the type, and it
 * silently drifted out of sync once already — copy/delete/importance/focus
 * were added to Capabilities but forgotten here, so a fully-capable identity's
 * admin pack quietly summarized as if those four didn't exist. types.ts now
 * has a compile-time exhaustiveness guard for this; this test is the
 * runtime-visible version of the same guarantee.
 */

import { expect, test } from "bun:test";
import { deriveValues } from "../src/render.ts";
import type { Capabilities, Config } from "../src/types.ts";

const ALL_ON: Capabilities = {
  markRead: true,
  download: true,
  move: true,
  copy: true,
  delete: true,
  categorize: true,
  flag: true,
  importance: true,
  focus: true,
  send: true,
  reply: true,
  forward: true,
};

test("CAPABILITIES_SUMMARY names every capability when all are enabled", () => {
  const cfg: Config = {
    tenantId: "contoso.onmicrosoft.com",
    clientId: "11111111-2222-3333-4444-555555555555",
    mailbox: "agent@contoso.com",
    certPath: "/tmp/x.crt",
    keyPath: "/tmp/x.key",
    capabilities: ALL_ON,
    allowlistGroup: "emissary-allowed@contoso.com",
  };
  const summary = deriveValues(cfg, "AABBCCDD").CAPABILITIES_SUMMARY;
  for (const key of Object.keys(ALL_ON)) {
    expect(summary).toContain(key);
  }
});
