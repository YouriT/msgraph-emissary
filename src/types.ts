/**
 * Shared type definitions for Emissary.
 *
 * These describe (a) the on-disk config/state shapes and (b) the subset of
 * Microsoft Graph resources we consume. Graph DTOs are intentionally partial —
 * we only type the fields we read, so a Graph schema change elsewhere can't
 * silently break us.
 */

// ---------------------------------------------------------------------------
// Config & state (on disk)
// ---------------------------------------------------------------------------

/**
 * What this identity is allowed to do beyond reading/listing mail. Reading is
 * always on — it's the point of the identity, and `doctor`'s negative test
 * needs it regardless. Each flag is an independent, deny-by-default gate
 * checked client-side before any Graph call — NOT derived from what Graph
 * permissions happen to be consented upstream, and NOT all 1:1 with a distinct
 * Exchange RBAC role. Two are worth calling out because they DON'T map 1:1:
 *   - `markRead` and `move` are separate actions an operator may want to allow
 *     independently, but both PATCH the mailbox, so both require the same
 *     `Application Mail.ReadWrite` role — enabling either upgrades the role.
 *   - `download` only ever needs `Application Mail.Read` (reading attachment
 *     bytes isn't a mailbox write), yet it's still its own toggle: writing
 *     attachment content to local disk is a materially different risk
 *     (exfiltration to the filesystem) from just viewing message text.
 * `send`/`reply`/`forward` are separate because they're different actions to
 * an operator even though all three need only `Application Mail.Send`; any of
 * them being enabled requires `allowlistGroup` and pulls in the transport
 * rule + allowlist-resolution Graph permissions.
 */
export interface Capabilities {
  /** read.ts's `PATCH isRead:true` side effect, and mark.ts (explicit read/unread). Needs Mail.ReadWrite. */
  markRead: boolean;
  /** download.ts writing attachment bytes to disk. Needs only Mail.Read. */
  download: boolean;
  /** move.ts. Needs Mail.ReadWrite. */
  move: boolean;
  /** copy.ts (duplicate into another folder). Needs Mail.ReadWrite. */
  copy: boolean;
  /** delete.ts. Needs Mail.ReadWrite. */
  delete: boolean;
  /** categorize.ts (add/remove Outlook categories). Needs Mail.ReadWrite. */
  categorize: boolean;
  /** flag.ts (follow-up flag: flagged/complete/notFlagged). Needs Mail.ReadWrite. */
  flag: boolean;
  /** importance.ts (low/normal/high). Needs Mail.ReadWrite. */
  importance: boolean;
  /** focus.ts (Focused Inbox classification override: focused/other). Needs Mail.ReadWrite. */
  focus: boolean;
  /** send.ts (compose new mail). Needs Mail.Send + allowlist. */
  send: boolean;
  /** reply.ts. Needs Mail.Send + allowlist. */
  reply: boolean;
  /** forward.ts. Needs Mail.Send + allowlist. */
  forward: boolean;
}

/** True if any capability that submits mail is enabled — these three share the allowlist/transport-rule requirement. */
export function needsSend(caps: Capabilities): boolean {
  return caps.send || caps.reply || caps.forward;
}

/** True if any capability needs write access to the mailbox (beyond reading attachment bytes). */
export function needsReadWrite(caps: Capabilities): boolean {
  return (
    caps.move ||
    caps.markRead ||
    caps.copy ||
    caps.delete ||
    caps.categorize ||
    caps.flag ||
    caps.importance ||
    caps.focus
  );
}

/** Persistent, operator-owned configuration. Lives at $XDG_CONFIG_HOME/emissary/config.json. */
export interface Config {
  /** Entra tenant (GUID or verified domain). */
  tenantId: string;
  /** Application (client) ID of the single-tenant Entra app registration. */
  clientId: string;
  /** The shared mailbox this identity is scoped to, e.g. agent@contoso.com. Never `/me`. */
  mailbox: string;
  /** What this identity may do beyond reading mail. */
  capabilities: Capabilities;
  /** Mail-enabled group whose membership is the outbound allowlist. Required iff send/reply/forward is enabled. */
  allowlistGroup?: string;
  /** Path to the PEM certificate (public) uploaded to Entra. */
  certPath: string;
  /** Path to the PEM private key (chmod 600). Signs the client assertion. */
  keyPath: string;
  /**
   * Optional mailbox the app must NOT be able to reach. `doctor` reads it and
   * expects a 403; a 200 means the Exchange RBAC scope is too broad.
   */
  negativeTestMailbox?: string;
}

/** A single onboarding step's persisted status. */
export type StepStatus = "pending" | "done";

/** The ordered onboarding steps (see SKILL/init wizard). */
export type OnboardingStep =
  | "prereqs"
  | "collect"
  | "cert"
  | "render-handoff"
  | "verify-token"
  | "verify-read"
  | "verify-negative"
  | "verify-allowlist"
  | "finish";

/** Resumable onboarding state. Lives at $XDG_STATE_HOME/emissary/onboarding.json. */
export interface OnboardingState {
  /** Schema version so we can migrate the file later without guessing. */
  version: 1;
  /** ISO timestamp of the last write (informational only). */
  updatedAt: string;
  /** Per-step status; absent step == pending. */
  steps: Partial<Record<OnboardingStep, StepStatus>>;
}

// ---------------------------------------------------------------------------
// Microsoft Graph DTOs (partial)
// ---------------------------------------------------------------------------

export interface GraphEmailAddress {
  name?: string;
  address?: string;
}

export interface GraphRecipient {
  emailAddress: GraphEmailAddress;
}

export interface GraphItemBody {
  contentType: "text" | "html";
  content: string;
}

/** followupFlag resource — Outlook's "flag for follow up" on a message. */
export interface GraphFollowupFlag {
  flagStatus?: "notFlagged" | "complete" | "flagged";
}

export interface GraphMessage {
  id: string;
  subject?: string;
  bodyPreview?: string;
  body?: GraphItemBody;
  from?: GraphRecipient;
  sender?: GraphRecipient;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  hasAttachments?: boolean;
  webLink?: string;
  conversationId?: string;
  parentFolderId?: string;
  categories?: string[];
  flag?: GraphFollowupFlag;
  importance?: "low" | "normal" | "high";
  inferenceClassification?: "focused" | "other";
}

export interface GraphMailFolder {
  id: string;
  displayName?: string;
  totalItemCount?: number;
  unreadItemCount?: number;
}

export interface GraphAttachment {
  id: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  /** Present on #microsoft.graph.fileAttachment; base64-encoded. */
  contentBytes?: string;
  "@odata.type"?: string;
}

export interface GraphDirectoryObject {
  id: string;
  "@odata.type"?: string;
  displayName?: string;
  mail?: string;
  userPrincipalName?: string;
  /** Present on #microsoft.graph.orgContact and groups. */
  address?: string;
}

/** Envelope for a Graph collection response. */
export interface GraphCollection<T> {
  value: T[];
  "@odata.nextLink"?: string;
}

/** Graph error envelope. */
export interface GraphError {
  error?: {
    code?: string;
    message?: string;
    innerError?: unknown;
  };
}

// ---------------------------------------------------------------------------
// Command result shapes (agent-facing JSON)
// ---------------------------------------------------------------------------

/** Uniform error object printed to stdout on failure (never contains tokens). */
export interface ErrorResult {
  ok: false;
  error: string;
  detail?: string;
}
