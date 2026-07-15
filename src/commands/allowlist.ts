/** `emissary allowlist` — show the resolved outbound allowlist members. */

import { resolveAllowlist } from "../allowlist.ts";
import { loadConfig } from "../config.ts";
import { Graph } from "../graph.ts";
import { printJson } from "../output.ts";

export async function allowlistCommand(_args: string[]): Promise<number> {
  const cfg = await loadConfig();
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
