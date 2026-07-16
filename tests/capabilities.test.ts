/**
 * Every write-ish action (markRead, download, move, send, reply, forward)
 * must refuse outright when ITS OWN capability is disabled, BEFORE ever
 * creating a Graph client — a read-only identity should never even attempt a
 * network call for an action it isn't allowed to take. Also guards against a
 * real bug class: reply/forward must check their OWN flag, not fall back to
 * checking `send` (they used to, incorrectly, share one combined check).
 * Drives the real command handlers against a temp XDG_CONFIG_HOME; no fetch
 * mock installed, so a stray Graph call would surface as an unhandled network
 * error rather than silently pass.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allowlistCommand } from "../src/commands/allowlist.ts";
import { downloadCommand } from "../src/commands/download.ts";
import { forwardCommand } from "../src/commands/forward.ts";
import { moveCommand } from "../src/commands/move.ts";
import { replyCommand } from "../src/commands/reply.ts";
import { sendCommand } from "../src/commands/send.ts";
import type { Capabilities } from "../src/types.ts";

let dir: string;
let origXdg: string | undefined;
let chunks: string[];
let origWrite: typeof process.stdout.write;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "emissary-caps-"));
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
  if (origXdg === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = origXdg;
  }
  await rm(dir, { recursive: true, force: true });
});

const ALL_OFF: Capabilities = {
  markRead: false,
  download: false,
  move: false,
  send: false,
  reply: false,
  forward: false,
};

async function writeConfig(capabilities: Partial<Capabilities>, allowlistGroup?: string): Promise<void> {
  const emissaryDir = join(dir, "emissary");
  await mkdir(emissaryDir, { recursive: true });
  const cfg = {
    tenantId: "contoso.onmicrosoft.com",
    clientId: "11111111-2222-3333-4444-555555555555",
    mailbox: "agent@contoso.com",
    capabilities: { ...ALL_OFF, ...capabilities },
    ...(allowlistGroup ? { allowlistGroup } : {}),
    certPath: join(emissaryDir, "x.crt"),
    keyPath: join(emissaryDir, "x.key"),
  };
  await writeFile(join(emissaryDir, "config.json"), JSON.stringify(cfg));
}

test("move refuses when capabilities.move is disabled", async () => {
  await writeConfig({});
  const code = await moveCommand(["abc123", "--to", "Archive"]);
  expect(code).toBe(1);
  expect(chunks.join("")).toContain("capabilities.move");
});

test("download refuses when capabilities.download is disabled", async () => {
  await writeConfig({});
  const code = await downloadCommand(["abc123", "file.pdf"]);
  expect(code).toBe(1);
  expect(chunks.join("")).toContain("capabilities.download");
});

test("send refuses when capabilities.send is disabled", async () => {
  await writeConfig({});
  const code = await sendCommand(["--to", "x@y.com", "--subject", "hi", "--body", "hi"]);
  expect(code).toBe(1);
  expect(chunks.join("")).toContain("capabilities.send");
});

test("reply refuses when capabilities.reply is disabled, even if send is enabled", async () => {
  await writeConfig({ send: true }, "emissary-allowed@contoso.com");
  const code = await replyCommand(["abc123", "--body", "hi"]);
  expect(code).toBe(1);
  expect(chunks.join("")).toContain("capabilities.reply");
});

test("forward refuses when capabilities.forward is disabled, even if send is enabled", async () => {
  await writeConfig({ send: true }, "emissary-allowed@contoso.com");
  const code = await forwardCommand(["abc123", "--to", "x@y.com"]);
  expect(code).toBe(1);
  expect(chunks.join("")).toContain("capabilities.forward");
});

test("allowlist command reports a no-op (not an error) when send/reply/forward are all disabled", async () => {
  await writeConfig({});
  const code = await allowlistCommand([]);
  expect(code).toBe(0);
  const out = chunks.join("");
  expect(out).toContain("send");
  expect(out).toContain("forward");
});
