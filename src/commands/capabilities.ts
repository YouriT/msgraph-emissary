/**
 * `emissary capabilities` — show what this identity is allowed to do.
 *
 * Lets an agent discover its enabled capabilities up front instead of
 * learning by trial and error from `capabilities.<name>` refusals. No Graph
 * call at all — just reads config.json, so it works even before `init` has
 * finished onboarding.
 */

import { loadConfig } from "../config.ts";
import { printJson } from "../output.ts";
import { needsSend } from "../types.ts";

export async function capabilitiesCommand(_args: string[]): Promise<number> {
  const cfg = await loadConfig();
  printJson({
    ok: true,
    mailbox: cfg.mailbox,
    capabilities: cfg.capabilities,
    canSubmitMail: needsSend(cfg.capabilities),
    allowlistGroup: cfg.allowlistGroup ?? null,
  });
  return 0;
}
