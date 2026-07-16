/**
 * `emissary mark <id> --read|--unread` — explicitly set a message's read
 * state. Shares capabilities.markRead with read.ts's automatic mark-as-read
 * side effect — both PATCH the same `isRead` property and need the same
 * Mail.ReadWrite role.
 */

import { boolFlag, parseArgs } from "../args.ts";
import { loadConfig } from "../config.ts";
import { Graph, usersPath } from "../graph.ts";
import { resolveMessageId } from "../mail.ts";
import { errorResult, printJson } from "../output.ts";

export async function markCommand(args: string[]): Promise<number> {
  const p = parseArgs(args);
  const given = p.positionals[0];
  const read = boolFlag(p, "read");
  const unread = boolFlag(p, "unread");
  if (!given || read === unread) {
    printJson(errorResult("usage: emissary mark <id> --read|--unread (exactly one)"));
    return 1;
  }
  const cfg = await loadConfig();
  if (!cfg.capabilities.markRead) {
    printJson(
      errorResult("marking read/unread is disabled for this identity (capabilities.markRead is not enabled)"),
    );
    return 1;
  }
  const graph = await Graph.create(cfg);
  const id = await resolveMessageId(graph, cfg, given);

  await graph.patch(usersPath(cfg.mailbox, "messages", id), { isRead: read });
  printJson({ ok: true, message: id, isRead: read });
  return 0;
}
