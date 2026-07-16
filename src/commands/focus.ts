/**
 * `emissary focus <id> --as focused|other` — set a message's Focused Inbox
 * classification. This only reclassifies the one message; it does not
 * change how future mail from that sender is classified (Graph's
 * inferenceClassificationOverride resource does that, per-sender — out of
 * scope here, since it's a mailbox-wide setting rather than a per-message
 * action).
 */

import { parseArgs, strFlag } from "../args.ts";
import { loadConfig } from "../config.ts";
import { Graph, usersPath } from "../graph.ts";
import { resolveMessageId } from "../mail.ts";
import { errorResult, printJson } from "../output.ts";

const VALID_CLASSIFICATIONS = ["focused", "other"] as const;
type Classification = (typeof VALID_CLASSIFICATIONS)[number];

function isClassification(v: string): v is Classification {
  return (VALID_CLASSIFICATIONS as readonly string[]).includes(v);
}

export async function focusCommand(args: string[]): Promise<number> {
  const p = parseArgs(args, ["as"]);
  const given = p.positionals[0];
  const as = strFlag(p, "as");
  if (!given || !as) {
    printJson(errorResult("usage: emissary focus <id> --as focused|other"));
    return 1;
  }
  if (!isClassification(as)) {
    printJson(errorResult(`invalid --as "${as}"`, `must be one of: ${VALID_CLASSIFICATIONS.join(", ")}`));
    return 1;
  }
  const cfg = await loadConfig();
  if (!cfg.capabilities.focus) {
    printJson(
      errorResult("focus classification is disabled for this identity (capabilities.focus is not enabled)"),
    );
    return 1;
  }
  const graph = await Graph.create(cfg);
  const id = await resolveMessageId(graph, cfg, given);

  await graph.patch(usersPath(cfg.mailbox, "messages", id), { inferenceClassification: as });
  printJson({ ok: true, message: id, inferenceClassification: as });
  return 0;
}
