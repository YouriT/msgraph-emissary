/**
 * `emissary delete <id>` — delete a message.
 *
 * Graph's DELETE on a message is Outlook's normal "Delete" action: it moves
 * the message to Deleted Items. If the message is already in Deleted Items
 * (or a similar recoverable-items location), this instead removes it from
 * there — closer to permanent. There is no separate "permanent delete"
 * command here; that's a materially more destructive, harder-to-reverse
 * operation than what was asked for.
 */

import { parseArgs } from "../args.ts";
import { loadConfig } from "../config.ts";
import { Graph, usersPath } from "../graph.ts";
import { resolveMessageId } from "../mail.ts";
import { errorResult, printJson } from "../output.ts";

export async function deleteCommand(args: string[]): Promise<number> {
  const p = parseArgs(args);
  const given = p.positionals[0];
  if (!given) {
    printJson(errorResult("usage: emissary delete <id>"));
    return 1;
  }
  const cfg = await loadConfig();
  if (!cfg.capabilities.delete) {
    printJson(
      errorResult("deleting messages is disabled for this identity (capabilities.delete is not enabled)"),
    );
    return 1;
  }
  const graph = await Graph.create(cfg);
  const id = await resolveMessageId(graph, cfg, given);

  await graph.request(usersPath(cfg.mailbox, "messages", id), { method: "DELETE" });
  printJson({
    ok: true,
    deleted: id,
    notice:
      "moved to Deleted Items (Outlook's normal delete) unless it was already there, in which case it's now permanently removed",
  });
  return 0;
}
