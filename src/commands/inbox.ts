/** `emissary inbox [--top N] [--folder NAME]` — list recent messages. */

import { numFlag, parseArgs, strFlag } from "../args.ts";
import { loadConfig } from "../config.ts";
import { Graph } from "../graph.ts";
import { listMessages, projectSummary } from "../mail.ts";
import { numbered, printJson } from "../output.ts";

export async function inboxCommand(args: string[]): Promise<number> {
  const p = parseArgs(args, ["top", "folder"]);
  const cfg = await loadConfig();
  const graph = await Graph.create(cfg);
  const msgs = await listMessages(graph, cfg, {
    folder: strFlag(p, "folder") ?? "inbox",
    top: numFlag(p, "top", 20),
  });
  printJson({ ok: true, count: msgs.length, messages: numbered(msgs.map(projectSummary)) });
  return 0;
}
