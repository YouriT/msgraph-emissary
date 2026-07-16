/**
 * `emissary categorize <id> [--add "Cat1,Cat2"] [--remove "Cat3"]` — add/remove
 * Outlook categories on a message.
 *
 * Graph has no atomic add/remove operation for a message's categories — the
 * whole `categories` array is replaced on PATCH. We read the current list,
 * apply the requested add/remove as a set, and PATCH the resulting array
 * back, so concurrent unrelated categories aren't clobbered.
 */

import { csvFlag, parseArgs } from "../args.ts";
import { loadConfig } from "../config.ts";
import { Graph, usersPath } from "../graph.ts";
import { resolveMessageId } from "../mail.ts";
import { errorResult, printJson } from "../output.ts";
import type { GraphMessage } from "../types.ts";

/** Pure merge logic (unit-tested directly): apply add/remove as a set over the current categories. */
export function applyCategoryChanges(current: string[], toAdd: string[], toRemove: string[]): string[] {
  const categories = new Set(current);
  for (const c of toRemove) categories.delete(c);
  for (const c of toAdd) categories.add(c);
  return [...categories];
}

export async function categorizeCommand(args: string[]): Promise<number> {
  const p = parseArgs(args, ["add", "remove"]);
  const given = p.positionals[0];
  const toAdd = csvFlag(p, "add");
  const toRemove = csvFlag(p, "remove");
  if (!given || (toAdd.length === 0 && toRemove.length === 0)) {
    printJson(errorResult('usage: emissary categorize <id> [--add "Cat1,Cat2"] [--remove "Cat3"]'));
    return 1;
  }
  const cfg = await loadConfig();
  if (!cfg.capabilities.categorize) {
    printJson(
      errorResult("categorizing is disabled for this identity (capabilities.categorize is not enabled)"),
    );
    return 1;
  }
  const graph = await Graph.create(cfg);
  const id = await resolveMessageId(graph, cfg, given);

  const current = await graph.get<GraphMessage>(usersPath(cfg.mailbox, "messages", id), {
    $select: "id,categories",
  });
  const result = applyCategoryChanges(current.categories ?? [], toAdd, toRemove);

  await graph.patch(usersPath(cfg.mailbox, "messages", id), { categories: result });
  printJson({ ok: true, message: id, categories: result });
  return 0;
}
