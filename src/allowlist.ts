/**
 * Outbound allowlist — the client-side preflight that refuses to send to any
 * address that is not a member of the configured mail-enabled group.
 *
 * This is the *outbound control plane*, independent of mailbox access. Even
 * though a transport rule enforces the same boundary admin-side (defense in
 * depth), Emissary refuses non-members BEFORE calling sendMail, so a bad send
 * never leaves the process.
 *
 * Resolving membership requires these Graph application permissions, each for a
 * specific reason:
 *   - Group.Read.All        → look the group up by its mail address
 *   - GroupMember.Read.All  → read transitive membership of that group
 *   - User.ReadBasic.All    → resolve member users' mail / UPN
 *   - OrgContact.Read.All   → resolve mail contacts that are group members
 */

import { type Graph, segs } from "./graph.ts";
import type { GraphCollection, GraphDirectoryObject } from "./types.ts";

export interface AllowlistMember {
  id: string;
  type: string;
  displayName: string | undefined;
  /** Best available email for this member (mail → UPN → address). */
  email: string | undefined;
}

export interface ResolvedAllowlist {
  groupId: string;
  groupName: string | undefined;
  members: AllowlistMember[];
  /** Lowercased set of every email that appears on any member. */
  emails: Set<string>;
}

function memberEmail(o: GraphDirectoryObject): string | undefined {
  return o.mail ?? o.userPrincipalName ?? o.address ?? undefined;
}

function shortType(odataType: string | undefined): string {
  if (!odataType) return "unknown";
  return odataType.replace("#microsoft.graph.", "");
}

/** Resolve the group id from a mail address or accept a GUID directly. */
async function resolveGroupId(graph: Graph, identifier: string): Promise<{ id: string; name?: string }> {
  // A raw GUID has no "@"; treat anything with "@" as a mail address to look up.
  if (!identifier.includes("@")) {
    const grp = await graph.get<GraphDirectoryObject>(`/${segs("groups", identifier)}`, {
      $select: "id,displayName",
    });
    return grp.displayName === undefined ? { id: grp.id } : { id: grp.id, name: grp.displayName };
  }
  const res = await graph.get<GraphCollection<GraphDirectoryObject>>("/groups", {
    // $filter value is a Graph OData literal; the single-quote is escaped by
    // doubling per OData rules, then URLSearchParams percent-encodes the whole.
    $filter: `mail eq '${identifier.replace(/'/g, "''")}'`,
    $select: "id,displayName",
  });
  const first = res.value[0];
  if (!first) {
    throw new Error(`allowlist group "${identifier}" not found (no group with that mail address)`);
  }
  return first.displayName === undefined ? { id: first.id } : { id: first.id, name: first.displayName };
}

/**
 * Resolve the full transitive membership of the allowlist group and index every
 * member email (lowercased) for O(1) preflight checks.
 */
export async function resolveAllowlist(graph: Graph, identifier: string): Promise<ResolvedAllowlist> {
  const group = await resolveGroupId(graph, identifier);
  const raw = await graph.paged<GraphDirectoryObject>(
    `/${segs("groups", group.id, "transitiveMembers")}`,
    { $select: "id,displayName,mail,userPrincipalName,address", $top: 999 },
    2000,
  );
  const members: AllowlistMember[] = raw.map((o) => ({
    id: o.id,
    type: shortType(o["@odata.type"]),
    displayName: o.displayName,
    email: memberEmail(o),
  }));
  const emails = new Set<string>();
  for (const m of members) {
    if (m.email) emails.add(m.email.toLowerCase());
  }
  return {
    groupId: group.id,
    groupName: group.name,
    members,
    emails,
  };
}

export interface PreflightResult {
  allowed: string[];
  blocked: string[];
  ok: boolean;
}

/** Normalize a recipient string to the bare address, lowercased. */
export function normalizeAddress(recipient: string): string {
  // Accept "Name <addr@x>" or bare "addr@x".
  const angle = recipient.match(/<([^>]+)>/);
  const addr = angle?.[1] ?? recipient;
  return addr.trim().toLowerCase();
}

/**
 * Check recipients against a resolved allowlist. Returns which are allowed and
 * which are blocked; `ok` is true only when NOTHING is blocked. The caller must
 * refuse to send when `ok` is false — there is deliberately no override flag.
 */
export function preflight(recipients: string[], allowlist: ResolvedAllowlist): PreflightResult {
  const allowed: string[] = [];
  const blocked: string[] = [];
  for (const r of recipients) {
    if (allowlist.emails.has(normalizeAddress(r))) allowed.push(r);
    else blocked.push(r);
  }
  return { allowed, blocked, ok: blocked.length === 0 };
}
