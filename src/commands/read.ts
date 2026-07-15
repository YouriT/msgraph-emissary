/**
 * `emissary read <id>` — fetch one message in full.
 *
 * The body is untrusted: it is HTML-stripped, truncated, and prefixed with an
 * injection notice by projectFull(). Also marks the message read as a side
 * effect (matches inbox-tool expectations); failures to mark are non-fatal.
 */

import { parseArgs } from "../args.ts";
import { loadConfig } from "../config.ts";
import { Graph, usersPath } from "../graph.ts";
import { getMessage, projectFull, resolveMessageId } from "../mail.ts";
import { errorResult, printJson } from "../output.ts";

export async function readCommand(args: string[]): Promise<number> {
  const p = parseArgs(args);
  const given = p.positionals[0];
  if (!given) {
    printJson(errorResult("read requires a message id: emissary read <id>"));
    return 1;
  }
  const cfg = await loadConfig();
  const graph = await Graph.create(cfg);
  const id = await resolveMessageId(graph, cfg, given);
  const msg = await getMessage(graph, cfg, id);

  // Best-effort mark-as-read; never fail the read over it.
  if (msg.isRead === false) {
    await graph.patch(usersPath(cfg.mailbox, "messages", id), { isRead: true }).catch(() => {});
  }

  printJson({ ok: true, message: projectFull(msg) });
  return 0;
}
