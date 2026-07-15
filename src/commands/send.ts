/**
 * `emissary send --to a@x[,b@y] --subject "..." --body "..." [--cc c@z]`
 *
 * The allowlist preflight ALWAYS runs before submission — every recipient
 * (to + cc) must be a member of the configured group, or nothing is sent.
 * There is deliberately no `--force`/override flag.
 *
 * A 202 from Graph means the message was SUBMITTED for delivery, not delivered.
 * Delivery failures surface later as an NDR in this mailbox's inbox.
 */

import { preflight, resolveAllowlist } from "../allowlist.ts";
import { parseArgs, strFlag } from "../args.ts";
import { loadConfig } from "../config.ts";
import { Graph, usersPath } from "../graph.ts";
import { parseRecipients, toRecipient } from "../mail.ts";
import { errorResult, printJson } from "../output.ts";
import type { GraphItemBody } from "../types.ts";

const SUBMISSION_NOTICE =
  "202 Accepted = submitted for delivery, NOT confirmed delivered. Delivery failures return as an NDR (non-delivery report) in this mailbox's inbox.";

export async function sendCommand(args: string[]): Promise<number> {
  const p = parseArgs(args, ["to", "cc", "subject", "body"]);
  const to = parseRecipients(strFlag(p, "to"));
  const cc = parseRecipients(strFlag(p, "cc"));
  const subject = strFlag(p, "subject") ?? "";
  const body = strFlag(p, "body") ?? "";

  if (to.length === 0) {
    printJson(errorResult("send requires at least one --to recipient"));
    return 1;
  }

  const cfg = await loadConfig();
  const graph = await Graph.create(cfg);

  // --- Preflight: mandatory, pre-submission ---
  const allowlist = await resolveAllowlist(graph, cfg.allowlistGroup);
  const pf = preflight([...to, ...cc], allowlist);
  if (!pf.ok) {
    printJson({
      ok: false,
      error: "blocked by allowlist preflight — not sent",
      blocked: pf.blocked,
      allowlistGroup: allowlist.groupName ?? cfg.allowlistGroup,
      hint: "recipients must be members of the allowlist group; there is no override",
    });
    return 1;
  }

  const messageBody: GraphItemBody = { contentType: "text", content: body };
  await graph.post(usersPath(cfg.mailbox, "sendMail"), {
    message: {
      subject,
      body: messageBody,
      toRecipients: to.map(toRecipient),
      ccRecipients: cc.map(toRecipient),
    },
    saveToSentItems: true,
  });

  printJson({
    ok: true,
    submitted: true,
    delivered: false,
    to,
    cc,
    subject,
    notice: SUBMISSION_NOTICE,
  });
  return 0;
}
