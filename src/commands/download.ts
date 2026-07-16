/**
 * `emissary download <id> <name> [--out DIR]` — save one file attachment.
 *
 * `<name>` selects the attachment by its (exact) name and is also the requested
 * save name. The destination is sanitized (no path separators, no "..") and
 * must stay inside the output dir and not already exist — see sanitize.ts.
 */

import { parseArgs, strFlag } from "../args.ts";
import { loadConfig } from "../config.ts";
import { Graph } from "../graph.ts";
import { getAttachment, listAttachments, resolveMessageId } from "../mail.ts";
import { errorResult, printJson } from "../output.ts";
import { safeDestination } from "../sanitize.ts";

export async function downloadCommand(args: string[]): Promise<number> {
  const p = parseArgs(args, ["out"]);
  const [given, name] = p.positionals;
  if (!given || !name) {
    printJson(errorResult("usage: emissary download <id> <name> [--out DIR]"));
    return 1;
  }
  const cfg = await loadConfig();
  if (!cfg.capabilities.download) {
    printJson(
      errorResult(
        "downloading attachments is disabled for this identity (capabilities.download is not enabled)",
      ),
    );
    return 1;
  }
  const graph = await Graph.create(cfg);
  const id = await resolveMessageId(graph, cfg, given);

  const atts = await listAttachments(graph, cfg, id);
  const matches = atts.filter((a) => a.name === name);
  if (matches.length === 0) {
    printJson(
      errorResult(
        `no attachment named "${name}" on message`,
        `available: ${atts.map((a) => a.name).join(", ") || "(none)"}`,
      ),
    );
    return 1;
  }
  if (matches.length > 1) {
    printJson(errorResult(`ambiguous: ${matches.length} attachments named "${name}" — cannot choose`));
    return 1;
  }
  const meta = matches[0]!;

  // Compute the safe destination BEFORE fetching bytes (fail fast, no overwrite).
  const outDir = strFlag(p, "out") ?? process.cwd();
  const dest = await safeDestination(outDir, name);

  const full = await getAttachment(graph, cfg, id, meta.id);
  if (!full.contentBytes) {
    printJson(errorResult(`"${name}" is not a downloadable file attachment (no contentBytes)`));
    return 1;
  }
  const bytes = Buffer.from(full.contentBytes, "base64");
  await Bun.write(dest, bytes);

  printJson({ ok: true, saved: dest, bytes: bytes.length, contentType: meta.contentType });
  return 0;
}
