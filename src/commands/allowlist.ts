/** `emissary allowlist` — show the resolved outbound allowlist members. */

import { resolveAllowlist } from "../allowlist.ts";
import { loadConfig } from "../config.ts";
import { Graph } from "../graph.ts";
import { printJson } from "../output.ts";
import { needsSend } from "../types.ts";

export async function allowlistCommand(_args: string[]): Promise<number> {
  const cfg = await loadConfig();
  if (!needsSend(cfg.capabilities) || !cfg.allowlistGroup) {
    printJson({
      ok: true,
      group: null,
      members: [],
      note: "send, reply, and forward are all disabled for this identity — no allowlist applies",
    });
    return 0;
  }
  const graph = await Graph.create(cfg);
  const resolved = await resolveAllowlist(graph, cfg.allowlistGroup);
  printJson({
    ok: true,
    group: resolved.groupName ?? cfg.allowlistGroup,
    groupId: resolved.groupId,
    memberCount: resolved.members.length,
    addressCount: resolved.emails.size,
    members: resolved.members.map((m, i) => ({
      n: i + 1,
      type: m.type,
      displayName: m.displayName,
      email: m.email,
    })),
  });
  return 0;
}
