/**
 * `emissary copy <id> --to FOLDER` — duplicate a message into another folder.
 *
 * Unlike `move`, the original message is untouched; this creates a second
 * copy (with its own new id) in the destination folder.
 */

import { parseArgs, strFlag } from "../args.ts";
import { loadConfig } from "../config.ts";
import { Graph, usersPath } from "../graph.ts";
import { resolveFolderId, resolveMessageId } from "../mail.ts";
import { errorResult, printJson, shortId } from "../output.ts";
import type { GraphMessage } from "../types.ts";

export async function copyCommand(args: string[]): Promise<number> {
  const p = parseArgs(args, ["to"]);
  const given = p.positionals[0];
  const to = strFlag(p, "to");
  if (!given || !to) {
    printJson(errorResult("usage: emissary copy <id> --to FOLDER"));
    return 1;
  }
  const cfg = await loadConfig();
  if (!cfg.capabilities.copy) {
    printJson(
      errorResult("copying messages is disabled for this identity (capabilities.copy is not enabled)"),
    );
    return 1;
  }
  const graph = await Graph.create(cfg);
  const id = await resolveMessageId(graph, cfg, given);
  const destinationId = await resolveFolderId(graph, cfg, to);

  const copied = await graph.post<GraphMessage>(usersPath(cfg.mailbox, "messages", id, "copy"), {
    destinationId,
  });
  printJson({ ok: true, copiedTo: to, originalId: id, newId: copied.id, short: shortId(copied.id) });
  return 0;
}
