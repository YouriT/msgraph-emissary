/**
 * `emissary unread [--top N] [--folder NAME] [--category "A,B"] [--from addr]
 *   [--has-attachments] [--importance low|normal|high]` — list unread messages.
 */

import { numFlag, parseArgs, strFlag } from "../args.ts";
import { loadConfig } from "../config.ts";
import { Graph } from "../graph.ts";
import { listMessages, parseListFilterFlags, projectSummary, VALID_IMPORTANCE_LEVELS } from "../mail.ts";
import { errorResult, numbered, printJson } from "../output.ts";

export async function unreadCommand(args: string[]): Promise<number> {
  const p = parseArgs(args, ["top", "folder", "from", "category", "importance"]);
  const parsed = parseListFilterFlags(p);
  if ("invalidImportance" in parsed) {
    printJson(
      errorResult(
        `invalid --importance "${parsed.invalidImportance}"`,
        `must be one of: ${VALID_IMPORTANCE_LEVELS.join(", ")}`,
      ),
    );
    return 1;
  }
  const cfg = await loadConfig();
  const graph = await Graph.create(cfg);
  const msgs = await listMessages(graph, cfg, {
    folder: strFlag(p, "folder") ?? "inbox",
    unreadOnly: true,
    top: numFlag(p, "top", 20),
    ...parsed.flags,
  });
  printJson({ ok: true, count: msgs.length, messages: numbered(msgs.map(projectSummary)) });
  return 0;
}
