/** `emissary folders` — list mail folders with item/unread counts. */

import { loadConfig } from "../config.ts";
import { Graph } from "../graph.ts";
import { listFolders } from "../mail.ts";
import { printJson, shortId } from "../output.ts";

export async function foldersCommand(_args: string[]): Promise<number> {
  const cfg = await loadConfig();
  const graph = await Graph.create(cfg);
  const folders = await listFolders(graph, cfg);
  const rows = folders.map((f, i) => ({
    n: i + 1,
    id: f.id,
    short: shortId(f.id),
    name: f.displayName,
    total: f.totalItemCount ?? 0,
    unread: f.unreadItemCount ?? 0,
  }));
  printJson({ ok: true, count: rows.length, folders: rows });
  return 0;
}
