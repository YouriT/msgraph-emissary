/**
 * `emissary forward <id> --to a@x[,b@y] [--comment "..."]` — forward a message.
 *
 * We specify the recipients, so the allowlist preflight runs UP FRONT — before
 * any draft is created. Only if every recipient is allowed do we create the
 * forward draft and send it.
 */

import { preflight, resolveAllowlist } from "../allowlist.ts";
import { parseArgs, strFlag } from "../args.ts";
import { loadConfig } from "../config.ts";
import { Graph, usersPath } from "../graph.ts";
import { parseRecipients, resolveMessageId, toRecipient } from "../mail.ts";
import { errorResult, printJson } from "../output.ts";
import type { GraphMessage } from "../types.ts";

const SUBMISSION_NOTICE =
  "Submitted for delivery, not confirmed delivered. Delivery failures return as an NDR in this mailbox's inbox.";

export async function forwardCommand(args: string[]): Promise<number> {
  const p = parseArgs(args, ["to", "comment"]);
  const given = p.positionals[0];
  const to = parseRecipients(strFlag(p, "to"));
  const comment = strFlag(p, "comment") ?? "";
  if (!given || to.length === 0) {
    printJson(errorResult('usage: emissary forward <id> --to a@x [--comment "..."]'));
    return 1;
  }
  const cfg = await loadConfig();
  const graph = await Graph.create(cfg);

  // Preflight BEFORE creating anything — recipients are known.
  const allowlist = await resolveAllowlist(graph, cfg.allowlistGroup);
  const pf = preflight(to, allowlist);
  if (!pf.ok) {
    printJson({
      ok: false,
      error: "blocked by allowlist preflight — not sent",
      blocked: pf.blocked,
      allowlistGroup: allowlist.groupName ?? cfg.allowlistGroup,
      hint: "forward recipients must be members of the allowlist group; there is no override",
    });
    return 1;
  }

  const id = await resolveMessageId(graph, cfg, given);
  const draft = await graph.post<GraphMessage>(usersPath(cfg.mailbox, "messages", id, "createForward"), {
    comment,
    toRecipients: to.map(toRecipient),
  });
  await graph.post(usersPath(cfg.mailbox, "messages", draft.id, "send"));

  printJson({ ok: true, submitted: true, delivered: false, forwarded: id, to, notice: SUBMISSION_NOTICE });
  return 0;
}
