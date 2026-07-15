/**
 * `emissary reply <id> --body "..."` — reply to a message.
 *
 * Reply recipients are decided by Graph from the original message, so we cannot
 * know them up front. We therefore use the draft-then-send pattern: create the
 * reply as a DRAFT, read its recipients, run the allowlist preflight, and only
 * then send. If the preflight blocks, the draft is deleted and nothing is sent.
 */

import { preflight, resolveAllowlist } from "../allowlist.ts";
import { parseArgs, strFlag } from "../args.ts";
import { loadConfig } from "../config.ts";
import { Graph, usersPath } from "../graph.ts";
import { resolveMessageId } from "../mail.ts";
import { errorResult, printJson } from "../output.ts";
import type { GraphMessage } from "../types.ts";

const SUBMISSION_NOTICE =
  "Submitted for delivery, not confirmed delivered. Delivery failures return as an NDR in this mailbox's inbox.";

function recipientAddresses(m: GraphMessage): string[] {
  const out: string[] = [];
  for (const r of [...(m.toRecipients ?? []), ...(m.ccRecipients ?? []), ...(m.bccRecipients ?? [])]) {
    const a = r.emailAddress.address;
    if (a) out.push(a);
  }
  return out;
}

export async function replyCommand(args: string[]): Promise<number> {
  const p = parseArgs(args, ["body"]);
  const given = p.positionals[0];
  const body = strFlag(p, "body");
  if (!given || body === undefined) {
    printJson(errorResult('usage: emissary reply <id> --body "..."'));
    return 1;
  }
  const cfg = await loadConfig();
  if (!cfg.capabilities.send || !cfg.allowlistGroup) {
    printJson(errorResult("sending is disabled for this identity (capabilities.send is not enabled)"));
    return 1;
  }
  const graph = await Graph.create(cfg);
  const id = await resolveMessageId(graph, cfg, given);

  // Create the reply as a draft (comment becomes the reply text).
  const draft = await graph.post<GraphMessage>(usersPath(cfg.mailbox, "messages", id, "createReply"), {
    comment: body,
  });
  const draftId = draft.id;

  // Read the draft's recipients authoritatively, then preflight.
  const draftRecips = await graph.get<GraphMessage>(usersPath(cfg.mailbox, "messages", draftId), {
    $select: "id,toRecipients,ccRecipients,bccRecipients",
  });
  const recipients = recipientAddresses(draftRecips);
  const allowlist = await resolveAllowlist(graph, cfg.allowlistGroup);
  const pf = preflight(recipients, allowlist);
  if (!pf.ok) {
    // Clean up the orphan draft so a blocked reply leaves no trace.
    await graph.request(usersPath(cfg.mailbox, "messages", draftId), { method: "DELETE" }).catch(() => {});
    printJson({
      ok: false,
      error: "blocked by allowlist preflight — not sent",
      blocked: pf.blocked,
      allowlistGroup: allowlist.groupName ?? cfg.allowlistGroup,
      hint: "reply recipients must be members of the allowlist group; there is no override",
    });
    return 1;
  }

  await graph.post(usersPath(cfg.mailbox, "messages", draftId, "send"));
  printJson({
    ok: true,
    submitted: true,
    delivered: false,
    inReplyTo: id,
    to: recipients,
    notice: SUBMISSION_NOTICE,
  });
  return 0;
}
