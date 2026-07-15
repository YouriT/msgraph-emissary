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
 * What this identity is allowed to do beyond reading mail. Reading is always
 * on — it's the point of the identity, and `doctor`'s negative test needs it
 * regardless. Each flag maps 1:1 to an Exchange RBAC application role, so
 * disabling one means the admin never has to grant it:
 *   move -> upgrades the mail role from `Application Mail.Read` to
 *           `Application Mail.ReadWrite` (moving a message is a write).
 *   send -> adds `Application Mail.Send`, the allowlist group, and the
 *           transport rule. Requires `allowlistGroup` to be set.
 */
export interface Capabilities {
  move: boolean;
  send: boolean;
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
  /** Mail-enabled group whose membership is the outbound allowlist. Required iff capabilities.send. */
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
