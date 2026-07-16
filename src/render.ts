/**
 * Render the admin handoff pack (`setup-admin.ps1` + `ADMIN.md`) from the
 * committed templates, substituting the operator's real values.
 *
 * Templates are imported as text (Bun import attributes), so they are embedded
 * in the compiled single binary — no runtime path dependency on the repo.
 * Placeholders are `{{NAME}}`; every one must have a value or rendering throws
 * (so we never ship a half-filled pack). `{{#FLAG}}...{{/FLAG}}` wraps a block
 * that's included only when that capability is enabled — used so a read-only
 * identity's admin pack never mentions Mail.Send, the allowlist group, or the
 * transport rule at all, rather than just saying "not needed" around them.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import adminMdTemplate from "../admin/ADMIN.md.tmpl" with { type: "text" };
import ps1Template from "../admin/setup-admin.ps1.tmpl" with { type: "text" };
import { adminHandoffDir } from "./config.ts";
import { type Capabilities, type Config, needsReadWrite, needsSend } from "./types.ts";

/** Derive a filesystem/identifier-safe token from the mailbox local part. */
function slug(mailbox: string): string {
  const local = mailbox.split("@")[0] ?? "mailbox";
  return (
    local
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "mailbox"
  );
}

export interface RenderValues {
  TENANT_ID: string;
  CLIENT_ID: string;
  ENTERPRISE_APP_OBJECT_ID: string;
  MAILBOX: string;
  APP_DISPLAY_NAME: string;
  SCOPE_NAME: string;
  CUSTOM_ATTR: string;
  CUSTOM_ATTR_VALUE: string;
  ALLOWLIST_GROUP: string;
  TRANSPORT_RULE_NAME: string;
  THUMBPRINT: string;
  /** e.g. "'Application Mail.Read'" or "'Application Mail.ReadWrite', 'Application Mail.Send'". */
  MAIL_ROLES_PS_ARRAY: string;
  /** e.g. "Mail.Read" or "Mail.ReadWrite, Mail.Send" — for the Graph-permission list. */
  MAIL_GRAPH_PERMISSIONS: string;
  /** e.g. "read" / "read, move, markRead" / "read, download, send, reply". */
  CAPABILITIES_SUMMARY: string;
}

export interface RenderFlags {
  /** True if send/reply/forward is enabled — pulls in the allowlist + transport rule. */
  SEND: boolean;
  /** Convenience negation of SEND — templates can't express `{{^SEND}}`, only `{{#FLAG}}`. */
  SEND_DISABLED: boolean;
}

/** Capability keys in the order they're listed everywhere (docs, prompts, summaries). */
const CAPABILITY_ORDER = [
  "markRead",
  "download",
  "move",
  "copy",
  "delete",
  "categorize",
  "flag",
  "importance",
  "focus",
  "send",
  "reply",
  "forward",
] as const satisfies readonly (keyof Capabilities)[];

// Compile-time guard: if `Capabilities` grows a key not listed above, this
// line fails to typecheck (with the missing key name in the error) instead
// of silently dropping it from every summary/admin-pack rendering forever.
type _MissingFromCapabilityOrder = Exclude<keyof Capabilities, (typeof CAPABILITY_ORDER)[number]>;
const _capabilityOrderIsExhaustive: _MissingFromCapabilityOrder extends never ? true : never = true;
void _capabilityOrderIsExhaustive;

/** Compute the full set of substitution values from config + cert thumbprint. */
export function deriveValues(cfg: Config, thumbprint: string): RenderValues {
  const s = slug(cfg.mailbox);
  const caps = cfg.capabilities;
  const readWrite = needsReadWrite(caps);
  const send = needsSend(caps);

  const mailRoles = [readWrite ? "Application Mail.ReadWrite" : "Application Mail.Read"];
  const mailGraphPerms = [readWrite ? "Mail.ReadWrite" : "Mail.Read"];
  if (send) {
    mailRoles.push("Application Mail.Send");
    mailGraphPerms.push("Mail.Send");
  }

  const capSummary = ["read", ...CAPABILITY_ORDER.filter((k) => caps[k])].join(", ");

  return {
    TENANT_ID: cfg.tenantId,
    CLIENT_ID: cfg.clientId,
    // The admin fills this from Entra > Enterprise applications; we can't know it.
    ENTERPRISE_APP_OBJECT_ID: "<ENTERPRISE-APP-OBJECT-ID>",
    MAILBOX: cfg.mailbox,
    APP_DISPLAY_NAME: `Emissary ${s}`,
    SCOPE_NAME: `Emissary-${s}-Scope`,
    CUSTOM_ATTR: "CustomAttribute15",
    CUSTOM_ATTR_VALUE: `emissary-${s}`,
    ALLOWLIST_GROUP: cfg.allowlistGroup ?? "",
    TRANSPORT_RULE_NAME: `Emissary-Outbound-${s}`,
    THUMBPRINT: thumbprint,
    MAIL_ROLES_PS_ARRAY: mailRoles.map((r) => `'${r}'`).join(", "),
    MAIL_GRAPH_PERMISSIONS: mailGraphPerms.join(", "),
    CAPABILITIES_SUMMARY: capSummary,
  };
}

export function deriveFlags(cfg: Config): RenderFlags {
  const send = needsSend(cfg.capabilities);
  return { SEND: send, SEND_DISABLED: !send };
}

/**
 * Render a template: strip `{{#FLAG}}...{{/FLAG}}` blocks based on `flags`,
 * then substitute every `{{KEY}}` from `values`. Throws if a flag/value is
 * missing, or if any `{{...}}` syntax remains unresolved — we never ship a
 * half-filled pack.
 */
export function fillTemplate(
  template: string,
  values: Record<string, string>,
  flags: Record<string, boolean> = {},
): string {
  let out = template.replace(/\{\{#([A-Z_]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, key: string, body: string) => {
    if (!(key in flags)) {
      throw new Error(`template flag {{#${key}}} has no value`);
    }
    return flags[key] ? body : "";
  });
  out = out.replace(/\{\{([A-Z_]+)\}\}/g, (_m, key: string) => {
    if (!(key in values)) {
      throw new Error(`template placeholder {{${key}}} has no value`);
    }
    return values[key]!;
  });
  if (out.includes("{{")) {
    const leftover = out.match(/\{\{[^}]*\}\}/)?.[0] ?? "{{...}}";
    throw new Error(`unresolved template syntax after render: ${leftover}`);
  }
  return out;
}

export interface RenderedPack {
  ps1Path: string;
  adminMdPath: string;
}

/** Render both files into the admin handoff dir and return their paths. */
export async function renderAdminPack(cfg: Config, thumbprint: string): Promise<RenderedPack> {
  const values = deriveValues(cfg, thumbprint) as unknown as Record<string, string>;
  const flags = deriveFlags(cfg) as unknown as Record<string, boolean>;
  const ps1 = fillTemplate(ps1Template, values, flags);
  const adminMd = fillTemplate(adminMdTemplate, values, flags);

  const dir = adminHandoffDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const ps1Path = join(dir, "setup-admin.ps1");
  const adminMdPath = join(dir, "ADMIN.md");
  await Bun.write(ps1Path, ps1);
  await Bun.write(adminMdPath, adminMd);
  return { ps1Path, adminMdPath };
}
