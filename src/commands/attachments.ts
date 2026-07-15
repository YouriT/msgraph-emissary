/** `emissary attachments <id>` — list a message's attachments (metadata only). */

import { parseArgs } from "../args.ts";
import { loadConfig } from "../config.ts";
import { Graph } from "../graph.ts";
import { listAttachments, resolveMessageId } from "../mail.ts";
import { errorResult, printJson, shortId } from "../output.ts";

export async function attachmentsCommand(args: string[]): Promise<number> {
  const p = parseArgs(args);
  const given = p.positionals[0];
  if (!given) {
    printJson(errorResult("attachments requires a message id: emissary attachments <id>"));
    return 1;
  }
  const cfg = await loadConfig();
  const graph = await Graph.create(cfg);
  const id = await resolveMessageId(graph, cfg, given);
  const atts = await listAttachments(graph, cfg, id);
  const rows = atts.map((a, i) => ({
    n: i + 1,
    id: a.id,
    short: shortId(a.id),
    name: a.name,
    contentType: a.contentType,
    size: a.size,
    inline: a.isInline === true,
  }));
  printJson({ ok: true, message: id, count: rows.length, attachments: rows });
  return 0;
}
