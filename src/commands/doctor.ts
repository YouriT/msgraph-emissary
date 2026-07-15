/**
 * `emissary doctor` — end-to-end self-test of the governed-identity posture.
 *
 * Runs four probes and reports a compact posture summary:
 *   1. token     — can we mint an app-only token at all?
 *   2. read      — can we read the TARGET mailbox? (Mail.Read/ReadWrite assignment)
 *   3. negative  — are we correctly BLOCKED from a mailbox we shouldn't reach?
 *                  A 403 is a PASS; a 200 is a FAIL (RBAC scope too broad).
 *   4. allowlist — does the outbound allowlist group resolve via Graph?
 *                  Skipped (not a failure) when capabilities.send is disabled.
 *
 * Exit code is non-zero if any hard check fails, so it can gate onboarding and
 * CI. Individual probes are exported so the init wizard can reuse them as gates.
 */

import { resolveAllowlist } from "../allowlist.ts";
import { loadConfig } from "../config.ts";
import { Graph, GraphHttpError, usersPath } from "../graph.ts";
import { printErrLine, printPrettyJson } from "../output.ts";
import type { Config } from "../types.ts";

export type CheckStatus = "pass" | "fail" | "warn" | "skip";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

/** Probe 1: token acquisition (also returns a bound client for reuse). */
export async function probeToken(cfg: Config): Promise<{ check: Check; graph?: Graph }> {
  try {
    const graph = await Graph.create(cfg);
    return { check: { name: "token", status: "pass", detail: "app-only token acquired" }, graph };
  } catch (err) {
    return {
      check: { name: "token", status: "fail", detail: err instanceof Error ? err.message : String(err) },
    };
  }
}

/** Probe 2: read the target mailbox (expects 200). */
export async function probeRead(graph: Graph, cfg: Config): Promise<Check> {
  const res = await graph.raw(usersPath(cfg.mailbox, "messages"), { query: { $top: 1, $select: "id" } });
  if (res.ok) {
    return { name: "read", status: "pass", detail: `read ${cfg.mailbox}` };
  }
  return { name: "read", status: "fail", detail: `cannot read ${cfg.mailbox}: HTTP ${res.status}` };
}

/**
 * Probe 3: the negative test. Reading a mailbox the app must NOT reach should
 * return 403. 200 means the Exchange RBAC scope is too broad — a hard fail.
 */
export async function probeNegative(graph: Graph, cfg: Config): Promise<Check> {
  if (!cfg.negativeTestMailbox) {
    return {
      name: "negative",
      status: "skip",
      detail: "no negativeTestMailbox configured — cannot prove scope is bounded",
    };
  }
  const res = await graph.raw(usersPath(cfg.negativeTestMailbox, "messages"), {
    query: { $top: 1, $select: "id" },
  });
  if (res.status === 403) {
    return { name: "negative", status: "pass", detail: `correctly denied ${cfg.negativeTestMailbox} (403)` };
  }
  if (res.status === 200) {
    return {
      name: "negative",
      status: "fail",
      detail: `SCOPE TOO BROAD: able to read ${cfg.negativeTestMailbox} (200) — Exchange RBAC scope is not restricting the app`,
    };
  }
  // 404/other: not a clean proof either way.
  return {
    name: "negative",
    status: "warn",
    detail: `inconclusive for ${cfg.negativeTestMailbox}: HTTP ${res.status} (expected 403)`,
  };
}

/** Probe 4: allowlist group resolves. Not applicable when send is disabled — nothing to check. */
export async function probeAllowlist(graph: Graph, cfg: Config): Promise<Check> {
  if (!cfg.capabilities.send || !cfg.allowlistGroup) {
    return {
      name: "allowlist",
      status: "skip",
      detail: "capabilities.send is disabled — this identity cannot send, so there is no allowlist to check",
    };
  }
  try {
    const resolved = await resolveAllowlist(graph, cfg.allowlistGroup);
    return {
      name: "allowlist",
      status: "pass",
      detail: `group "${resolved.groupName ?? cfg.allowlistGroup}" resolved to ${resolved.members.length} member(s), ${resolved.emails.size} address(es)`,
    };
  } catch (err) {
    const detail =
      err instanceof GraphHttpError
        ? `${err.status}: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    return { name: "allowlist", status: "fail", detail };
  }
}

/** Run all probes and return the ordered check list. */
export async function runDoctor(cfg: Config): Promise<Check[]> {
  const checks: Check[] = [];
  const { check: tokenCheck, graph } = await probeToken(cfg);
  checks.push(tokenCheck);
  if (!graph) return checks; // nothing else can run without a token

  checks.push(await probeRead(graph, cfg));
  checks.push(await probeNegative(graph, cfg));
  checks.push(await probeAllowlist(graph, cfg));
  return checks;
}

export async function doctorCommand(_args: string[]): Promise<number> {
  const cfg = await loadConfig();
  const checks = await runDoctor(cfg);
  const failed = checks.filter((c) => c.status === "fail");
  const posture = {
    mailbox: cfg.mailbox,
    tenantId: cfg.tenantId,
    checks,
    summary: failed.length === 0 ? "healthy" : `${failed.length} check(s) failed`,
  };
  printPrettyJson(posture);
  for (const c of checks) {
    printErrLine(`  [${c.status.toUpperCase()}] ${c.name}: ${c.detail}`);
  }
  return failed.length === 0 ? 0 : 1;
}
