/**
 * Config location & (de)serialization.
 *
 * Follows the XDG Base Directory spec (matching OpenClaw):
 *   - config  → $XDG_CONFIG_HOME/emissary/   (default ~/.config/emissary/)
 *   - state   → $XDG_STATE_HOME/emissary/    (default ~/.local/state/emissary/)
 *
 * The certificate and private key live alongside config.json in the config dir.
 * The private key is created chmod 600 by the cert generator; we never relax it.
 */

import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Capabilities, type Config, needsSend } from "./types.ts";

const APP = "emissary";

/** $XDG_CONFIG_HOME/emissary, defaulting to ~/.config/emissary. */
export function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim();
  return join(base && base.length > 0 ? base : join(homedir(), ".config"), APP);
}

/** $XDG_STATE_HOME/emissary, defaulting to ~/.local/state/emissary. */
export function stateDir(): string {
  const base = process.env.XDG_STATE_HOME?.trim();
  return join(base && base.length > 0 ? base : join(homedir(), ".local", "state"), APP);
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

/** Default on-disk locations for the cert material within the config dir. */
export function defaultCertPath(): string {
  return join(configDir(), "emissary.crt");
}
export function defaultKeyPath(): string {
  return join(configDir(), "emissary.key");
}

/** Where the rendered admin handoff pack is written by `init`. */
export function adminHandoffDir(): string {
  return join(configDir(), "admin");
}

/** Create the config dir (0700) if missing. */
export async function ensureConfigDir(): Promise<void> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  // recursive mkdir won't re-chmod an existing dir; enforce it explicitly.
  await chmod(configDir(), 0o700).catch(() => {});
}

/** Create the state dir (0700) if missing. */
export async function ensureStateDir(): Promise<void> {
  await mkdir(stateDir(), { recursive: true, mode: 0o700 });
  await chmod(stateDir(), 0o700).catch(() => {});
}

const REQUIRED_STRING_FIELDS: (keyof Config)[] = ["tenantId", "clientId", "mailbox"];

/** Every capability defaults to `false` (deny-by-default) unless explicitly `true`. */
function parseCapabilities(raw: unknown): Capabilities {
  const obj = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    markRead: obj.markRead === true,
    download: obj.download === true,
    move: obj.move === true,
    send: obj.send === true,
    reply: obj.reply === true,
    forward: obj.forward === true,
  };
}

/**
 * Validate a parsed object into a Config. Throws with a precise message on the
 * first problem — used both when loading from disk and when ingesting a
 * user-supplied `--config file.json` for non-interactive init.
 */
export function validateConfig(raw: unknown): Config {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("config must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  for (const field of REQUIRED_STRING_FIELDS) {
    const v = obj[field];
    if (typeof v !== "string" || v.trim().length === 0) {
      throw new Error(`config field "${field}" is required and must be a non-empty string`);
    }
  }
  const mailbox = String(obj.mailbox);
  if (!mailbox.includes("@")) {
    throw new Error(`config field "mailbox" must be an email address, got "${mailbox}"`);
  }
  const capabilities = parseCapabilities(obj.capabilities);

  // The allowlist is only meaningful — and only required — when this identity
  // can submit mail (send, reply, or forward). An identity with none of those
  // enabled never needs one, never gets the extra Graph permissions, and
  // never triggers the allowlist onboarding gate.
  let allowlistGroup: string | undefined;
  const rawAllowlist = obj.allowlistGroup;
  if (needsSend(capabilities)) {
    if (typeof rawAllowlist !== "string" || rawAllowlist.trim().length === 0) {
      throw new Error('config field "allowlistGroup" is required when send, reply, or forward is enabled');
    }
    allowlistGroup = rawAllowlist.trim();
  } else if (typeof rawAllowlist === "string" && rawAllowlist.trim().length > 0) {
    allowlistGroup = rawAllowlist.trim();
  }

  const certPath =
    typeof obj.certPath === "string" && obj.certPath.trim().length > 0
      ? String(obj.certPath).trim()
      : defaultCertPath();
  const keyPath =
    typeof obj.keyPath === "string" && obj.keyPath.trim().length > 0
      ? String(obj.keyPath).trim()
      : defaultKeyPath();
  const cfg: Config = {
    tenantId: String(obj.tenantId).trim(),
    clientId: String(obj.clientId).trim(),
    mailbox: mailbox.trim(),
    capabilities,
    certPath,
    keyPath,
  };
  if (allowlistGroup) cfg.allowlistGroup = allowlistGroup;
  const neg = obj.negativeTestMailbox;
  if (typeof neg === "string" && neg.trim().length > 0) {
    cfg.negativeTestMailbox = neg.trim();
  }
  return cfg;
}

/** Load and validate config.json. Throws a friendly error if absent. */
export async function loadConfig(): Promise<Config> {
  const path = configPath();
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`no config found at ${path} — run \`emissary init\` first`);
  }
  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch {
    throw new Error(`config at ${path} is not valid JSON`);
  }
  return validateConfig(parsed);
}

/** Persist config.json (pretty-printed) and lock the file to 0600. */
export async function saveConfig(cfg: Config): Promise<void> {
  await ensureConfigDir();
  const path = configPath();
  await Bun.write(path, `${JSON.stringify(cfg, null, 2)}\n`);
  await chmod(path, 0o600).catch(() => {});
}
