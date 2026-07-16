/**
 * `emissary unread [--top N] [--folder NAME] [--category "A,B"] [--from addr]
 *   [--has-attachments] [--importance low|normal|high] [--next URL]` — list
 *   unread messages.
 *
 * Each page is capped at --top (max 100). If more results are available, the
 * output includes `nextLink` — pass that back as `--next` on a later call to
 * fetch the next page.
 */

import { numFlag, parseArgs, strFlag } from "../args.ts";
import { loadConfig } from "../config.ts";
import { Graph } from "../graph.ts";
import { listMessages, parseListFilterFlags, projectSummary, VALID_IMPORTANCE_LEVELS } from "../mail.ts";
import { errorResult, numbered, printJson } from "../output.ts";

export async function unreadCommand(args: string[]): Promise<number> {
  const p = parseArgs(args, ["top", "folder", "from", "category", "importance", "next"]);
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
  const next = strFlag(p, "next");
  const result = await listMessages(graph, cfg, {
    folder: strFlag(p, "folder") ?? "inbox",
    unreadOnly: true,
    top: numFlag(p, "top", 20),
    ...parsed.flags,
    ...(next ? { next } : {}),
  });
  printJson({
    ok: true,
    count: result.messages.length,
    messages: numbered(result.messages.map(projectSummary)),
    nextLink: result.nextLink ?? null,
  });
  return 0;
}
