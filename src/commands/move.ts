/** `emissary move <id> --to FOLDER` — move a message to another folder. */

import { parseArgs, strFlag } from "../args.ts";
import { loadConfig } from "../config.ts";
import { Graph, usersPath } from "../graph.ts";
import { resolveFolderId, resolveMessageId } from "../mail.ts";
import { errorResult, printJson, shortId } from "../output.ts";
import type { GraphMessage } from "../types.ts";

export async function moveCommand(args: string[]): Promise<number> {
  const p = parseArgs(args, ["to"]);
  const given = p.positionals[0];
  const to = strFlag(p, "to");
  if (!given || !to) {
    printJson(errorResult("usage: emissary move <id> --to FOLDER"));
    return 1;
  }
  const cfg = await loadConfig();
  const graph = await Graph.create(cfg);
  const id = await resolveMessageId(graph, cfg, given);
  const destinationId = await resolveFolderId(graph, cfg, to);

  // /messages/{id}/move returns the message in its new location (new id).
  const moved = await graph.post<GraphMessage>(usersPath(cfg.mailbox, "messages", id, "move"), {
    destinationId,
  });
  printJson({ ok: true, movedTo: to, newId: moved.id, short: shortId(moved.id) });
  return 0;
}
