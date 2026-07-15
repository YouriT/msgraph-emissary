/**
 * `emissary stats` — mailbox summary derived from folder counts.
 *
 * Aggregates per-folder totals so an agent can gauge mailbox size/unread load
 * without paging every message.
 */

import { loadConfig } from "../config.ts";
import { Graph } from "../graph.ts";
import { listFolders } from "../mail.ts";
import { printJson } from "../output.ts";

export async function statsCommand(_args: string[]): Promise<number> {
  const cfg = await loadConfig();
  const graph = await Graph.create(cfg);
  const folders = await listFolders(graph, cfg);

  let totalItems = 0;
  let totalUnread = 0;
  for (const f of folders) {
    totalItems += f.totalItemCount ?? 0;
    totalUnread += f.unreadItemCount ?? 0;
  }
  const inbox = folders.find((f) => (f.displayName ?? "").toLowerCase() === "inbox");

  printJson({
    ok: true,
    mailbox: cfg.mailbox,
    folders: folders.length,
    totalItems,
    totalUnread,
    inbox: inbox ? { total: inbox.totalItemCount ?? 0, unread: inbox.unreadItemCount ?? 0 } : null,
  });
  return 0;
}
