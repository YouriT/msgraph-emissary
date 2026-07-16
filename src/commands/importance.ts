/** `emissary importance <id> --level low|normal|high` — set a message's importance/priority. */

import { parseArgs, strFlag } from "../args.ts";
import { loadConfig } from "../config.ts";
import { Graph, usersPath } from "../graph.ts";
import { resolveMessageId } from "../mail.ts";
import { errorResult, printJson } from "../output.ts";

const VALID_LEVELS = ["low", "normal", "high"] as const;
type ImportanceLevel = (typeof VALID_LEVELS)[number];

function isImportanceLevel(v: string): v is ImportanceLevel {
  return (VALID_LEVELS as readonly string[]).includes(v);
}

export async function importanceCommand(args: string[]): Promise<number> {
  const p = parseArgs(args, ["level"]);
  const given = p.positionals[0];
  const level = strFlag(p, "level");
  if (!given || !level) {
    printJson(errorResult("usage: emissary importance <id> --level low|normal|high"));
    return 1;
  }
  if (!isImportanceLevel(level)) {
    printJson(errorResult(`invalid --level "${level}"`, `must be one of: ${VALID_LEVELS.join(", ")}`));
    return 1;
  }
  const cfg = await loadConfig();
  if (!cfg.capabilities.importance) {
    printJson(
      errorResult(
        "setting importance is disabled for this identity (capabilities.importance is not enabled)",
      ),
    );
    return 1;
  }
  const graph = await Graph.create(cfg);
  const id = await resolveMessageId(graph, cfg, given);

  await graph.patch(usersPath(cfg.mailbox, "messages", id), { importance: level });
  printJson({ ok: true, message: id, importance: level });
  return 0;
}
