/**
 * `emissary init --reconfigure`'s merge logic: re-answering capabilities
 * must keep identity fields (tenant/client/mailbox/cert paths) untouched,
 * default every yes/no prompt to the CURRENT capability (not hardcoded
 * false) so re-running to add one capability doesn't force re-declaring
 * everything already enabled, and only prompt for a fresh allowlist group
 * when a submit capability newly turns on and none is set yet.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Asker,
  collectReconfigure,
  initCommand,
  RECONFIGURE_KEEP,
  RECONFIGURE_REVERIFY,
} from "../src/commands/init.ts";
import { ONBOARDING_STEPS } from "../src/state.ts";
import type { Config } from "../src/types.ts";

test("RECONFIGURE_KEEP + RECONFIGURE_REVERIFY cover every ONBOARDING_STEPS entry exactly once", () => {
  // Same bug class as the earlier CAPABILITY_ORDER omission: a manually
  // maintained array parallel to a canonical list can silently drift when a
  // new onboarding step is added later. Guard it here instead of trusting
  // eyeballing.
  const combined = [...RECONFIGURE_KEEP, ...RECONFIGURE_REVERIFY].sort();
  expect(combined).toEqual([...ONBOARDING_STEPS].sort());
});

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

const READ_ONLY: Config = {
  tenantId: "contoso.onmicrosoft.com",
  clientId: "11111111-2222-3333-4444-555555555555",
  mailbox: "agent@contoso.com",
  capabilities: {
    markRead: false,
    download: false,
    move: false,
    copy: false,
    delete: false,
    categorize: false,
    flag: false,
    importance: false,
    focus: false,
    send: false,
    reply: false,
    forward: false,
  },
  certPath: "/config/emissary.crt",
  keyPath: "/config/emissary.key",
};

test("all-Enter reconfigure keeps every capability and every identity field unchanged", async () => {
  const rl = fakeAsker(Array(12).fill(""));
  const updated = await collectReconfigure(rl, READ_ONLY);
  expect(updated.capabilities).toEqual(READ_ONLY.capabilities);
  expect(updated.tenantId).toBe(READ_ONLY.tenantId);
  expect(updated.clientId).toBe(READ_ONLY.clientId);
  expect(updated.mailbox).toBe(READ_ONLY.mailbox);
  expect(updated.certPath).toBe(READ_ONLY.certPath);
  expect(updated.keyPath).toBe(READ_ONLY.keyPath);
});

test("answering only 'move' flips just that one capability, defaults keep the rest", async () => {
  // Order: markRead, download, move, copy, delete, categorize, flag, importance, focus, send, reply, forward
  const rl = fakeAsker(["", "", "y", "", "", "", "", "", "", "", "", ""]);
  const updated = await collectReconfigure(rl, READ_ONLY);
  expect(updated.capabilities).toEqual({ ...READ_ONLY.capabilities, move: true });
});

test("newly enabling send with no existing allowlist prompts for one", async () => {
  // 12 capability answers, then the allowlist prompt.
  const answers = ["", "", "", "", "", "", "", "", "", "y", "", ""]; // send: "y"
  answers.push("emissary-allowed@contoso.com");
  const rl = fakeAsker(answers);
  const updated = await collectReconfigure(rl, READ_ONLY);
  expect(updated.capabilities.send).toBe(true);
  expect(updated.allowlistGroup).toBe("emissary-allowed@contoso.com");
});

test("send already on with an existing allowlist does NOT re-prompt for one", async () => {
  const sendEnabled: Config = {
    ...READ_ONLY,
    capabilities: { ...READ_ONLY.capabilities, send: true },
    allowlistGroup: "already-set@contoso.com",
  };
  // Exactly 12 answers (all Enter, keeping send:true by default) — if the
  // implementation asked for a 13th (allowlist) answer, fakeAsker would
  // return "" for it too, which would blank out the existing group and fail
  // askRequiredEmail's non-empty check, hanging or throwing — it must not.
  const rl = fakeAsker(Array(12).fill(""));
  const updated = await collectReconfigure(rl, sendEnabled);
  expect(updated.capabilities.send).toBe(true);
  expect(updated.allowlistGroup).toBe("already-set@contoso.com");
});

// --------------------------------------------------------------------------
// initCommand-level guard clauses (don't require a real TTY to exercise —
// this sandbox's process.stdin.isTTY is naturally undefined, same precedent
// tests/init-wizard.test.ts already relies on).
// --------------------------------------------------------------------------

let configDir: string;
let stateDir: string;
let origXdgConfig: string | undefined;
let origXdgState: string | undefined;
let chunks: string[];
let origWrite: typeof process.stdout.write;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), "emissary-reconfig-config-"));
  stateDir = await mkdtemp(join(tmpdir(), "emissary-reconfig-state-"));
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
  if (origXdgConfig === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = origXdgConfig;
  if (origXdgState === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = origXdgState;
  await rm(configDir, { recursive: true, force: true });
  await rm(stateDir, { recursive: true, force: true });
});

test("--reconfigure and --config together is rejected with a clear error", async () => {
  const code = await initCommand(["--reconfigure", "--config", "/tmp/whatever.json"]);
  expect(code).toBe(1);
  const parsed = JSON.parse(chunks.join("").trim());
  expect(parsed.ok).toBe(false);
  expect(parsed.error).toContain("mutually exclusive");
});

test("--reconfigure in a non-interactive environment is rejected instead of silently no-op'ing", async () => {
  const code = await initCommand(["--reconfigure"]);
  expect(code).toBe(1);
  const parsed = JSON.parse(chunks.join("").trim());
  expect(parsed.ok).toBe(false);
  expect(parsed.error).toContain("interactive terminal");
});
