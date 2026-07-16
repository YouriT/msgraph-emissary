/**
 * Regression test for a real shipped bug: `init`'s verify-token gate used to
 * call Graph.create() directly and unguarded, which THROWS UNCAUGHT when the
 * cert hasn't been uploaded to Entra yet — exactly the state right after the
 * `render-handoff` step, i.e. the normal, expected pause point of every single
 * onboarding run. That crashed the whole wizard with a raw top-level error
 * instead of the intended graceful "paused, waiting on the admin" message.
 *
 * Drives the real `initCommand` against a temp XDG_CONFIG_HOME/XDG_STATE_HOME
 * with prereqs/collect/cert/render-handoff pre-marked done (so only
 * verify-token runs), a real self-signed cert on disk (unregistered anywhere),
 * and a mocked login.microsoftonline.com that fails the token request — since
 * MSAL's HTTP client goes through globalThis.fetch, this reproduces the exact
 * failure offline, no live network or real tenant required.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCommand } from "../src/commands/init.ts";
import { generateCert } from "../src/openssl.ts";
import { installMockFetch, type MockHandle } from "./helpers/mockFetch.ts";

let configDir: string;
let stateDir: string;
let origXdgConfig: string | undefined;
let origXdgState: string | undefined;
let chunks: string[];
let origWrite: typeof process.stdout.write;
let handle: MockHandle | undefined;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "emissary-init-config-"));
  stateDir = await mkdtemp(join(tmpdir(), "emissary-init-state-"));
  origXdgConfig = process.env.XDG_CONFIG_HOME;
  origXdgState = process.env.XDG_STATE_HOME;
  process.env.XDG_CONFIG_HOME = configDir;
  process.env.XDG_STATE_HOME = stateDir;
  chunks = [];
  origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => {
    chunks.push(String(s));
    return true;
  }) as typeof process.stdout.write;
});

afterEach(async () => {
  process.stdout.write = origWrite;
  handle?.restore();
  if (origXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = origXdgConfig;
  if (origXdgState === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = origXdgState;
  await rm(configDir, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

test("init does not crash when the cert isn't registered in Entra yet — pauses gracefully at verify-token", async () => {
  const emissaryConfigDir = join(configDir, "emissary");
  const emissaryStateDir = join(stateDir, "emissary");
  await mkdir(emissaryConfigDir, { recursive: true });
  await mkdir(emissaryStateDir, { recursive: true });

  const certPath = join(emissaryConfigDir, "emissary.crt");
  const keyPath = join(emissaryConfigDir, "emissary.key");
  await generateCert({ certPath, keyPath, commonName: "agent@contoso.com" });

  await writeFile(
    join(emissaryConfigDir, "config.json"),
    JSON.stringify({
      tenantId: "contoso.onmicrosoft.com",
      clientId: "11111111-2222-3333-4444-555555555555",
      mailbox: "agent@contoso.com",
      capabilities: {
        markRead: false,
        download: false,
        move: false,
        send: false,
        reply: false,
        forward: false,
      },
      certPath,
      keyPath,
    }),
  );

  // Every step up through render-handoff already done — only verify-token runs.
  await writeFile(
    join(emissaryStateDir, "onboarding.json"),
    JSON.stringify({
      version: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      steps: { prereqs: "done", collect: "done", cert: "done", "render-handoff": "done" },
    }),
  );

  // MSAL's HTTP client goes through globalThis.fetch — this is what a cert
  // that isn't uploaded to Entra yet actually returns (AADSTS700027-shaped).
  handle = installMockFetch([
    {
      method: "POST",
      match: (u) => u.includes("login.microsoftonline.com"),
      status: 401,
      json: { error: "invalid_client", error_description: "AADSTS700027: certificate not registered" },
    },
  ]);

  const exitCode = await initCommand([]);

  expect(exitCode).toBe(1);
  const out = chunks.join("");
  // The wizard must degrade to a structured "paused" result, NOT an uncaught
  // top-level crash (which would print a bare {"ok":false,"error":"..."} with
  // no "paused" field and no completed-steps list).
  const parsed = JSON.parse(out.trim().split("\n").pop()!);
  expect(parsed.ok).toBe(false);
  expect(parsed.paused).toBe("verify-token");
  expect(parsed.completed).toEqual(["prereqs", "collect", "cert", "render-handoff"]);
});
