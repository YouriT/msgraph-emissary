/**
 * `emissary capabilities` lets an agent discover what it's allowed to do
 * up front, instead of learning only from `capabilities.<name>` refusals
 * after the fact. No Graph call — just reads config.json.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilitiesCommand } from "../src/commands/capabilities.ts";

let dir: string;
let origXdg: string | undefined;
let chunks: string[];
let origWrite: typeof process.stdout.write;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "emissary-capcmd-"));
  origXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  chunks = [];
  origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((s: string | Uint8Array) => {
    chunks.push(String(s));
    return true;
  }) as typeof process.stdout.write;
});

afterEach(async () => {
  process.stdout.write = origWrite;
  if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = origXdg;
  await rm(dir, { recursive: true, force: true });
});

test("capabilities reports the configured capabilities and allowlist, with no Graph call", async () => {
  const emissaryDir = join(dir, "emissary");
  await mkdir(emissaryDir, { recursive: true });
  await writeFile(
    join(emissaryDir, "config.json"),
    JSON.stringify({
      tenantId: "contoso.onmicrosoft.com",
      clientId: "11111111-2222-3333-4444-555555555555",
      mailbox: "agent@contoso.com",
      capabilities: {
        markRead: false,
        download: true,
        move: false,
        copy: false,
        delete: false,
        categorize: true,
        flag: false,
        importance: false,
        focus: false,
        send: true,
        reply: false,
        forward: false,
      },
      allowlistGroup: "emissary-allowed@contoso.com",
      certPath: join(emissaryDir, "x.crt"),
      keyPath: join(emissaryDir, "x.key"),
    }),
  );

  const code = await capabilitiesCommand([]);
  expect(code).toBe(0);
  const parsed = JSON.parse(chunks.join("").trim());
  expect(parsed.ok).toBe(true);
  expect(parsed.mailbox).toBe("agent@contoso.com");
  expect(parsed.capabilities.download).toBe(true);
  expect(parsed.capabilities.categorize).toBe(true);
  expect(parsed.canSubmitMail).toBe(true);
  expect(parsed.allowlistGroup).toBe("emissary-allowed@contoso.com");
});

test("capabilities reports canSubmitMail:false and allowlistGroup:null for a read-only identity", async () => {
  const emissaryDir = join(dir, "emissary");
  await mkdir(emissaryDir, { recursive: true });
  await writeFile(
    join(emissaryDir, "config.json"),
    JSON.stringify({
      tenantId: "contoso.onmicrosoft.com",
      clientId: "11111111-2222-3333-4444-555555555555",
      mailbox: "agent@contoso.com",
      certPath: join(emissaryDir, "x.crt"),
      keyPath: join(emissaryDir, "x.key"),
    }),
  );

  const code = await capabilitiesCommand([]);
  expect(code).toBe(0);
  const parsed = JSON.parse(chunks.join("").trim());
  expect(parsed.canSubmitMail).toBe(false);
  expect(parsed.allowlistGroup).toBeNull();
});
