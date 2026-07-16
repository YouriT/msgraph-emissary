/**
 * `emissary flag <id> --status flagged|complete|notFlagged` — set Outlook's
 * follow-up flag on a message. `notFlagged` clears an existing flag.
 */

import { parseArgs, strFlag } from "../args.ts";
import { loadConfig } from "../config.ts";
import { Graph, usersPath } from "../graph.ts";
import { resolveMessageId } from "../mail.ts";
import { errorResult, printJson } from "../output.ts";

const VALID_STATUSES = ["notFlagged", "flagged", "complete"] as const;
type FlagStatus = (typeof VALID_STATUSES)[number];

function isFlagStatus(v: string): v is FlagStatus {
  return (VALID_STATUSES as readonly string[]).includes(v);
}

export async function flagCommand(args: string[]): Promise<number> {
  const p = parseArgs(args, ["status"]);
  const given = p.positionals[0];
  const status = strFlag(p, "status");
  if (!given || !status) {
    printJson(errorResult("usage: emissary flag <id> --status flagged|complete|notFlagged"));
    return 1;
  }
  if (!isFlagStatus(status)) {
    printJson(errorResult(`invalid --status "${status}"`, `must be one of: ${VALID_STATUSES.join(", ")}`));
    return 1;
  }
  const cfg = await loadConfig();
  if (!cfg.capabilities.flag) {
    printJson(errorResult("flagging is disabled for this identity (capabilities.flag is not enabled)"));
    return 1;
  }
  const graph = await Graph.create(cfg);
  const id = await resolveMessageId(graph, cfg, given);

  await graph.patch(usersPath(cfg.mailbox, "messages", id), { flag: { flagStatus: status } });
  printJson({ ok: true, message: id, flagStatus: status });
  return 0;
}
