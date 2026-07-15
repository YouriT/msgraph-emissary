/**
 * Render the admin handoff pack (`setup-admin.ps1` + `ADMIN.md`) from the
 * committed templates, substituting the operator's real values.
 *
 * Templates are imported as text (Bun import attributes), so they are embedded
 * in the compiled single binary — no runtime path dependency on the repo.
 * Placeholders are `{{NAME}}`; every one must have a value or rendering throws
 * (so we never ship a half-filled pack).
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import adminMdTemplate from "../admin/ADMIN.md.tmpl" with { type: "text" };
import ps1Template from "../admin/setup-admin.ps1.tmpl" with { type: "text" };
import { adminHandoffDir } from "./config.ts";
import type { Config } from "./types.ts";

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
}

/** Compute the full set of substitution values from config + cert thumbprint. */
export function deriveValues(cfg: Config, thumbprint: string): RenderValues {
  const s = slug(cfg.mailbox);
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
    ALLOWLIST_GROUP: cfg.allowlistGroup,
    TRANSPORT_RULE_NAME: `Emissary-Outbound-${s}`,
    THUMBPRINT: thumbprint,
  };
}

/** Replace every `{{KEY}}` in `template`; throw if any placeholder is left. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  const out = template.replace(/\{\{([A-Z_]+)\}\}/g, (_m, key: string) => {
    if (!(key in values)) {
      throw new Error(`template placeholder {{${key}}} has no value`);
    }
    return values[key]!;
  });
  const leftover = out.match(/\{\{[A-Z_]+\}\}/);
  if (leftover) throw new Error(`unresolved placeholder after render: ${leftover[0]}`);
  return out;
}

export interface RenderedPack {
  ps1Path: string;
  adminMdPath: string;
}

/** Render both files into the admin handoff dir and return their paths. */
export async function renderAdminPack(cfg: Config, thumbprint: string): Promise<RenderedPack> {
  const values = deriveValues(cfg, thumbprint) as unknown as Record<string, string>;
  const ps1 = fillTemplate(ps1Template, values);
  const adminMd = fillTemplate(adminMdTemplate, values);

  const dir = adminHandoffDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const ps1Path = join(dir, "setup-admin.ps1");
  const adminMdPath = join(dir, "ADMIN.md");
  await Bun.write(ps1Path, ps1);
  await Bun.write(adminMdPath, adminMd);
  return { ps1Path, adminMdPath };
}
