/**
 * `emissary search --query "..." [--top N] [--folder NAME] [--category "A,B"]
 *   [--from addr] [--has-attachments] [--importance low|normal|high]` — full-text search.
 *
 * Graph does not allow $search to combine with $filter for messages at all,
 * so --from/--has-attachments/--importance ride along as ANDed KQL clauses
 * instead (mail.ts's listMessages handles this) — --category can't, since
 * categories aren't a KQL-searchable property, so it's applied client-side
 * on the returned page.
 */

import { numFlag, parseArgs, strFlag } from "../args.ts";
import { loadConfig } from "../config.ts";
import { Graph } from "../graph.ts";
import { listMessages, parseListFilterFlags, projectSummary, VALID_IMPORTANCE_LEVELS } from "../mail.ts";
import { errorResult, numbered, printJson } from "../output.ts";

export async function searchCommand(args: string[]): Promise<number> {
  const p = parseArgs(args, ["query", "top", "folder", "from", "category", "importance"]);
  const query = strFlag(p, "query") ?? p.positionals.join(" ");
  if (!query.trim()) {
    printJson(errorResult('search requires --query "..."'));
    return 1;
  }
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
  const folder = strFlag(p, "folder");
  const msgs = await listMessages(graph, cfg, {
    ...(folder ? { folder } : {}),
    search: query,
    top: numFlag(p, "top", 20),
    ...parsed.flags,
  });
  printJson({ ok: true, query, count: msgs.length, messages: numbered(msgs.map(projectSummary)) });
  return 0;
}
