/** `emissary search --query "..." [--top N] [--folder NAME]` — full-text search. */

import { numFlag, parseArgs, strFlag } from "../args.ts";
import { loadConfig } from "../config.ts";
import { Graph } from "../graph.ts";
import { listMessages, projectSummary } from "../mail.ts";
import { errorResult, numbered, printJson } from "../output.ts";

export async function searchCommand(args: string[]): Promise<number> {
  const p = parseArgs(args, ["query", "top", "folder"]);
  const query = strFlag(p, "query") ?? p.positionals.join(" ");
  if (!query.trim()) {
    printJson(errorResult('search requires --query "..."'));
    return 1;
  }
  const cfg = await loadConfig();
  const graph = await Graph.create(cfg);
  const msgs = await listMessages(graph, cfg, {
    ...(strFlag(p, "folder") ? { folder: strFlag(p, "folder")! } : {}),
    search: query,
    top: numFlag(p, "top", 20),
  });
  printJson({ ok: true, query, count: msgs.length, messages: numbered(msgs.map(projectSummary)) });
  return 0;
}
