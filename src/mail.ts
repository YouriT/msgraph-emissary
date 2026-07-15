/**
 * Mail-domain helpers shared across commands.
 *
 * Centralizes message projection (compact agent JSON), safe message-id
 * resolution (exact match wins; ambiguous suffix errors instead of guessing),
 * folder resolution, and attachment fetching — so every command speaks Graph
 * the same, injection-safe way via the `Graph` client.
 */

import { type Graph, GraphHttpError, usersPath } from "./graph.ts";
import { shortId } from "./output.ts";
import { renderBody } from "./sanitize.ts";
import type {
  Config,
  GraphAttachment,
  GraphCollection,
  GraphMailFolder,
  GraphMessage,
  GraphRecipient,
} from "./types.ts";

/** Split a `--to`/`--cc` value into individual addresses (comma/semicolon). */
export function parseRecipients(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Build a Graph recipient object from a bare address (typed, never string-built). */
export function toRecipient(address: string): GraphRecipient {
  return { emailAddress: { address } };
}

export class AmbiguousIdError extends Error {
  constructor(readonly matches: string[]) {
    super(`ambiguous message id: ${matches.length} messages match that suffix — use the full id`);
    this.name = "AmbiguousIdError";
  }
}
export class NotFoundError extends Error {}

/** Fields we request for message summaries — keep payloads small. */
const SUMMARY_SELECT =
  "id,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,hasAttachments,bodyPreview";
const FULL_SELECT = `${SUMMARY_SELECT},body,webLink,conversationId,parentFolderId`;

function addr(r: { emailAddress: { name?: string; address?: string } } | undefined): string | undefined {
  if (!r) return undefined;
  const a = r.emailAddress;
  return a.address ?? a.name ?? undefined;
}

export interface MessageSummary {
  id: string;
  short: string;
  from: string | undefined;
  subject: string;
  received: string | undefined;
  unread: boolean;
  hasAttachments: boolean;
  preview: string;
}

/** Compact summary row for lists. */
export function projectSummary(m: GraphMessage): MessageSummary {
  return {
    id: m.id,
    short: shortId(m.id),
    from: addr(m.from ?? m.sender),
    subject: m.subject ?? "(no subject)",
    received: m.receivedDateTime ?? m.sentDateTime,
    unread: m.isRead === false,
    hasAttachments: m.hasAttachments === true,
    preview: (m.bodyPreview ?? "").slice(0, 140),
  };
}

/** Full message projection, with the untrusted body rendered + notice-prefixed. */
export function projectFull(m: GraphMessage): Record<string, unknown> {
  const body = m.body
    ? renderBody(m.body.content, m.body.contentType === "html" ? "html" : "text")
    : renderBody(m.bodyPreview ?? "", "text");
  return {
    id: m.id,
    short: shortId(m.id),
    from: addr(m.from ?? m.sender),
    to: (m.toRecipients ?? []).map((r) => addr(r)).filter(Boolean),
    cc: (m.ccRecipients ?? []).map((r) => addr(r)).filter(Boolean),
    subject: m.subject ?? "(no subject)",
    received: m.receivedDateTime ?? m.sentDateTime,
    unread: m.isRead === false,
    hasAttachments: m.hasAttachments === true,
    webLink: m.webLink,
    notice: body.notice,
    body: body.content,
    truncated: body.truncated,
  };
}

export interface ListOptions {
  folder?: string;
  search?: string;
  unreadOnly?: boolean;
  top?: number;
}

/**
 * List messages from a folder (or the whole mailbox). Uses $search when a query
 * is given (Graph requires ConsistencyLevel: eventual and forbids $orderby with
 * $search), otherwise $filter/$orderby by receivedDateTime.
 */
export async function listMessages(graph: Graph, cfg: Config, opts: ListOptions): Promise<GraphMessage[]> {
  const top = Math.min(Math.max(opts.top ?? 20, 1), 100);
  const base = opts.folder
    ? usersPath(cfg.mailbox, "mailFolders", await resolveFolderId(graph, cfg, opts.folder), "messages")
    : usersPath(cfg.mailbox, "messages");

  if (opts.search) {
    // $search cannot combine with $orderby; results come back by relevance.
    const res = await graph.get<GraphCollection<GraphMessage>>(
      base,
      { $search: `"${opts.search.replace(/"/g, '\\"')}"`, $select: SUMMARY_SELECT, $top: top },
      { ConsistencyLevel: "eventual" },
    );
    return res.value;
  }

  const query: Record<string, string | number> = {
    $select: SUMMARY_SELECT,
    $top: top,
    $orderby: "receivedDateTime desc",
  };
  if (opts.unreadOnly) query.$filter = "isRead eq false";
  const res = await graph.get<GraphCollection<GraphMessage>>(base, query);
  return res.value;
}

/** Fetch a single message by exact id (already resolved). */
export async function getMessage(graph: Graph, cfg: Config, id: string): Promise<GraphMessage> {
  return graph.get<GraphMessage>(usersPath(cfg.mailbox, "messages", id), { $select: FULL_SELECT });
}

/**
 * Pure suffix-matching logic (unit-tested directly). Exact id match always
 * wins. Otherwise match ids ending with the given suffix: exactly one → unique;
 * more than one → ambiguous (caller must error, never guess); zero → none.
 */
export function matchIdSuffix(
  ids: string[],
  given: string,
): { kind: "exact" | "unique" | "ambiguous" | "none"; id?: string; matches?: string[] } {
  if (ids.includes(given)) return { kind: "exact", id: given };
  const matches = ids.filter((id) => id.endsWith(given));
  if (matches.length === 1) return { kind: "unique", id: matches[0]! };
  if (matches.length > 1) return { kind: "ambiguous", matches };
  return { kind: "none" };
}

/**
 * Resolve a user-supplied id (which may be a full id or a short suffix) to a
 * full message id. Tries an exact GET first; on 404 falls back to suffix
 * matching against recent messages, erroring on ambiguity.
 */
export async function resolveMessageId(graph: Graph, cfg: Config, given: string): Promise<string> {
  const exact = await graph.raw(usersPath(cfg.mailbox, "messages", given), { query: { $select: "id" } });
  if (exact.ok) return given;
  if (exact.status !== 404)
    throw new GraphHttpError(exact.status, undefined, `lookup failed: HTTP ${exact.status}`);

  const recent = await graph.get<GraphCollection<GraphMessage>>(usersPath(cfg.mailbox, "messages"), {
    $select: "id",
    $top: 200,
    $orderby: "receivedDateTime desc",
  });
  const result = matchIdSuffix(
    recent.value.map((m) => m.id),
    given,
  );
  if (result.kind === "exact" || result.kind === "unique") return result.id!;
  if (result.kind === "ambiguous") throw new AmbiguousIdError(result.matches!);
  throw new NotFoundError(`no message found for id "${given}"`);
}

/** Well-known folder ids Graph accepts directly (no lookup needed). */
const WELL_KNOWN_FOLDERS = new Set([
  "inbox",
  "drafts",
  "sentitems",
  "deleteditems",
  "junkemail",
  "archive",
  "outbox",
  "clutter",
  "conflicts",
  "recoverableitemsdeletions",
]);

/** Resolve a folder name or id to a folder id. Ambiguous display names error. */
export async function resolveFolderId(graph: Graph, cfg: Config, nameOrId: string): Promise<string> {
  const lower = nameOrId.toLowerCase();
  if (WELL_KNOWN_FOLDERS.has(lower)) return lower;

  const res = await graph.get<GraphCollection<GraphMailFolder>>(usersPath(cfg.mailbox, "mailFolders"), {
    $select: "id,displayName",
    $top: 200,
  });
  const exactId = res.value.find((f) => f.id === nameOrId);
  if (exactId) return exactId.id;
  const byName = res.value.filter((f) => (f.displayName ?? "").toLowerCase() === lower);
  if (byName.length === 1) return byName[0]!.id;
  if (byName.length > 1)
    throw new Error(`ambiguous folder name "${nameOrId}" — ${byName.length} folders match`);
  throw new NotFoundError(`folder "${nameOrId}" not found`);
}

/** List mail folders as compact rows. */
export async function listFolders(graph: Graph, cfg: Config): Promise<GraphMailFolder[]> {
  const res = await graph.get<GraphCollection<GraphMailFolder>>(usersPath(cfg.mailbox, "mailFolders"), {
    $select: "id,displayName,totalItemCount,unreadItemCount",
    $top: 200,
  });
  return res.value;
}

/** List attachment metadata (no contentBytes) for a message. */
export async function listAttachments(
  graph: Graph,
  cfg: Config,
  messageId: string,
): Promise<GraphAttachment[]> {
  const res = await graph.get<GraphCollection<GraphAttachment>>(
    usersPath(cfg.mailbox, "messages", messageId, "attachments"),
    { $select: "id,name,contentType,size,isInline" },
  );
  return res.value;
}

/** Fetch a single attachment WITH contentBytes for download. */
export async function getAttachment(
  graph: Graph,
  cfg: Config,
  messageId: string,
  attachmentId: string,
): Promise<GraphAttachment> {
  return graph.get<GraphAttachment>(
    usersPath(cfg.mailbox, "messages", messageId, "attachments", attachmentId),
  );
}
