/**
 * Mail-domain helpers shared across commands.
 *
 * Centralizes message projection (compact agent JSON), safe message-id
 * resolution (exact match wins; ambiguous suffix errors instead of guessing),
 * folder resolution, and attachment fetching — so every command speaks Graph
 * the same, injection-safe way via the `Graph` client.
 */

import { boolFlag, csvFlag, type ParsedArgs, strFlag } from "./args.ts";
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

/** The message `importance` enum, shared by importance.ts (setting it) and the list filters (querying by it). */
export const VALID_IMPORTANCE_LEVELS = ["low", "normal", "high"] as const;
export type ImportanceLevel = (typeof VALID_IMPORTANCE_LEVELS)[number];
export function isImportanceLevel(v: string): v is ImportanceLevel {
  return (VALID_IMPORTANCE_LEVELS as readonly string[]).includes(v);
}

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
  "id,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,isRead,hasAttachments,bodyPreview,categories,importance";
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
  categories: string[];
  importance: string | undefined;
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
    categories: m.categories ?? [],
    importance: m.importance,
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

/** The filter-flag subset shared by inbox/unread/search: --category/--from/--has-attachments/--importance. */
export type ListFilterFlags = Pick<ListOptions, "categories" | "from" | "hasAttachments" | "importance">;

/**
 * Parse the filter flags shared by inbox/unread/search. Returns the invalid
 * raw value under `invalidImportance` instead of throwing, since each caller
 * prints its own errorResult and needs the exact command name in the message.
 */
export function parseListFilterFlags(
  p: ParsedArgs,
): { flags: ListFilterFlags } | { invalidImportance: string } {
  const importanceRaw = strFlag(p, "importance");
  if (importanceRaw !== undefined && !isImportanceLevel(importanceRaw)) {
    return { invalidImportance: importanceRaw };
  }
  const from = strFlag(p, "from");
  const flags: ListFilterFlags = { categories: csvFlag(p, "category") };
  if (from) flags.from = from;
  if (boolFlag(p, "has-attachments")) flags.hasAttachments = true;
  if (importanceRaw) flags.importance = importanceRaw;
  return { flags };
}

export interface ListOptions {
  folder?: string;
  search?: string;
  unreadOnly?: boolean;
  top?: number;
  /** OR-matched: a message with ANY of these categories matches. */
  categories?: string[];
  /** Sender address. Exact match in $filter mode; substring in $search (KQL) mode. */
  from?: string;
  hasAttachments?: boolean;
  importance?: ImportanceLevel;
}

/** Escape a value for a single-quoted OData string literal (doubles embedded quotes). */
export function odataQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The OR-of-any() clause for a set of category names — AND-ing categories
 * together (`.../any(...) and .../any(...)`) is a known Graph limitation that
 * silently returns zero results, so this is deliberately "has any of these",
 * not "has all of these".
 */
export function categoryFilterClause(categories: string[]): string {
  return categories.map((c) => `categories/any(a:a eq ${odataQuote(c)})`).join(" or ");
}

/** Escape text for a KQL `$search` clause value (Graph's own escaping rule: backslash-escape `"` and `\`). */
export function kqlEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** KQL's `importance:` values are low/medium/high — "medium", not "normal" like the message property's own enum. */
export function kqlImportance(level: ImportanceLevel): "low" | "medium" | "high" {
  return level === "normal" ? "medium" : level;
}

/**
 * List messages from a folder (or the whole mailbox).
 *
 * Uses $search (KQL) when a free-text query is given; Graph does not allow
 * $search to combine with $filter or $orderby for messages at all, so any
 * structured predicate (from/hasAttachments/importance) rides along as an
 * ANDed KQL clause instead. Categories aren't a KQL-searchable property, so
 * they're applied client-side on the returned page in $search mode.
 *
 * Otherwise builds a single ANDed $filter (unreadOnly, from, hasAttachments,
 * importance, categories) plus $orderby by receivedDateTime.
 */
export async function listMessages(graph: Graph, cfg: Config, opts: ListOptions): Promise<GraphMessage[]> {
  const top = Math.min(Math.max(opts.top ?? 20, 1), 100);
  const base = opts.folder
    ? usersPath(cfg.mailbox, "mailFolders", await resolveFolderId(graph, cfg, opts.folder), "messages")
    : usersPath(cfg.mailbox, "messages");

  if (opts.search) {
    const clauses = [`"${kqlEscape(opts.search)}"`];
    if (opts.from) clauses.push(`"from:${kqlEscape(opts.from)}"`);
    if (opts.hasAttachments !== undefined) clauses.push(`"hasAttachments:${opts.hasAttachments}"`);
    if (opts.importance) clauses.push(`"importance:${kqlImportance(opts.importance)}"`);
    const res = await graph.get<GraphCollection<GraphMessage>>(
      base,
      { $search: clauses.join(" AND "), $select: SUMMARY_SELECT, $top: top },
      { ConsistencyLevel: "eventual" },
    );
    if (!opts.categories?.length) return res.value;
    const wanted = new Set(opts.categories);
    return res.value.filter((m) => (m.categories ?? []).some((c) => wanted.has(c)));
  }

  const filters: string[] = [];
  if (opts.unreadOnly) filters.push("isRead eq false");
  if (opts.from) filters.push(`from/emailAddress/address eq ${odataQuote(opts.from)}`);
  if (opts.hasAttachments !== undefined) filters.push(`hasAttachments eq ${opts.hasAttachments}`);
  if (opts.importance) filters.push(`importance eq ${odataQuote(opts.importance)}`);
  if (opts.categories?.length) filters.push(`(${categoryFilterClause(opts.categories)})`);

  const query: Record<string, string | number> = {
    $select: SUMMARY_SELECT,
    $top: top,
    $orderby: "receivedDateTime desc",
  };
  if (filters.length > 0) query.$filter = filters.join(" and ");
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
