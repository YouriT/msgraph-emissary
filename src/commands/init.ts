/**
 * `emissary init` — resumable onboarding wizard.
 *
 * Setup spans two personas: the operator (runs this CLI) and an Exchange/Entra
 * admin (runs the generated PowerShell + consents to permissions). This wizard
 * records step state under $XDG_STATE_HOME/emissary/onboarding.json and resumes
 * at the first incomplete step, so the operator can stop after generating the
 * admin pack, wait for the admin, then re-run to verify.
 *
 * Every admin-dependent step is a GATE: it is only marked done after the
 * relevant `doctor` probe actually succeeds — never assumed.
 *
 * Modes:
 *   emissary init                    interactive (prompts on stderr)
 *   emissary init --config file.json non-interactive; same verification gates
 */

import { createInterface } from "node:readline/promises";
import { parseArgs, strFlag } from "../args.ts";
import { certThumbprintSha256 } from "../auth.ts";
import {
  configDir,
  defaultCertPath,
  defaultKeyPath,
  loadConfig,
  saveConfig,
  validateConfig,
} from "../config.ts";
import { Graph } from "../graph.ts";
import { generateCert, opensslAvailable } from "../openssl.ts";
import { printErrLine, printJson } from "../output.ts";
import { renderAdminPack } from "../render.ts";
import { loadOnboarding, markStep, ONBOARDING_STEPS, stepStatus } from "../state.ts";
import type { Config, OnboardingState, OnboardingStep } from "../types.ts";
import { probeAllowlist, probeNegative, probeRead, probeToken } from "./doctor.ts";

type StepResult = "done" | "blocked";

interface Ctx {
  state: OnboardingState;
  interactive: boolean;
}

// --------------------------------------------------------------------------
// Prompting
// --------------------------------------------------------------------------

/** The one readline method these prompts need — kept minimal so it's trivial to fake in tests. */
export interface Asker {
  question(prompt: string): Promise<string>;
}

/** Re-prompt until a non-empty answer is given — a required field is never silently accepted empty. */
export async function askRequired(rl: Asker, prompt: string): Promise<string> {
  for (;;) {
    const answer = (await rl.question(`${prompt} (required): `)).trim();
    if (answer.length > 0) return answer;
    printErrLine("  This field is required — please enter a value.");
  }
}

/** Like askRequired, but also requires the answer to look like an email address. */
export async function askRequiredEmail(rl: Asker, prompt: string): Promise<string> {
  for (;;) {
    const answer = await askRequired(rl, prompt);
    if (answer.includes("@")) return answer;
    printErrLine(`  "${answer}" doesn't look like an email address — must contain "@".`);
  }
}

/** Yes/no prompt with a default on empty input (Enter). */
export async function askYesNo(rl: Asker, prompt: string, defaultValue: boolean): Promise<boolean> {
  const suffix = defaultValue ? "[Y/n]" : "[y/N]";
  for (;;) {
    const answer = (await rl.question(`${prompt} ${suffix}: `)).trim().toLowerCase();
    if (answer === "") return defaultValue;
    if (answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    printErrLine('  Please answer "y" or "n".');
  }
}

async function collectInteractive(): Promise<Config> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    printErrLine("\n=== Emissary onboarding: collect configuration ===");
    const tenantId = await askRequired(rl, "Entra tenant ID (GUID or domain)");
    const clientId = await askRequired(rl, "App (client) ID");
    const mailbox = await askRequiredEmail(rl, "Shared mailbox address (e.g. agent@contoso.com)");

    printErrLine("\nReading mail is always enabled. Choose any extra capabilities this identity needs:");
    const move = await askYesNo(rl, "  Allow moving messages between folders?", false);
    const send = await askYesNo(rl, "  Allow sending mail (send/reply/forward)?", false);

    let allowlistGroup: string | undefined;
    if (send) {
      allowlistGroup = await askRequiredEmail(
        rl,
        "Allowlist group address (e.g. emissary-allowed@contoso.com)",
      );
    }
    const negative = (
      await rl.question("Negative-test mailbox (optional, a mailbox the app must NOT reach): ")
    ).trim();

    const cfg: Config = {
      tenantId,
      clientId,
      mailbox,
      capabilities: { move, send },
      certPath: defaultCertPath(),
      keyPath: defaultKeyPath(),
    };
    if (allowlistGroup) cfg.allowlistGroup = allowlistGroup;
    if (negative.length > 0) cfg.negativeTestMailbox = negative;
    return validateConfig(cfg);
  } finally {
    rl.close();
  }
}

// --------------------------------------------------------------------------
// Steps
// --------------------------------------------------------------------------

async function stepPrereqs(): Promise<StepResult> {
  const hasOpenssl = await opensslAvailable();
  const reachable = await Promise.all([
    canReach("https://login.microsoftonline.com"),
    canReach("https://graph.microsoft.com"),
  ]);
  const problems: string[] = [];
  if (!hasOpenssl) problems.push("openssl not found on PATH");
  if (!reachable[0]) problems.push("cannot reach login.microsoftonline.com");
  if (!reachable[1]) problems.push("cannot reach graph.microsoft.com");
  if (problems.length > 0) {
    printErrLine("Prerequisite checks failed:");
    for (const p of problems) printErrLine(`  - ${p}`);
    return "blocked";
  }
  printErrLine("Prerequisites OK (openssl present, endpoints reachable).");
  return "done";
}

async function canReach(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(8000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

async function stepCollect(ctx: Ctx): Promise<StepResult> {
  // Non-interactive collect must come from --config, handled before the loop.
  if (!ctx.interactive) {
    printErrLine("No config collected. Provide `emissary init --config file.json` or run in a terminal.");
    return "blocked";
  }
  const cfg = await collectInteractive();
  await saveConfig(cfg);
  printErrLine(`Config saved to ${configDir()}/config.json`);
  return "done";
}

async function stepCert(): Promise<StepResult> {
  const cfg = await loadConfig();
  const haveCert = await Bun.file(cfg.certPath).exists();
  const haveKey = await Bun.file(cfg.keyPath).exists();

  let thumbprint: string;
  if (haveCert && haveKey) {
    thumbprint = certThumbprintSha256(await Bun.file(cfg.certPath).text());
    printErrLine("Certificate already present — reusing it.");
  } else {
    printErrLine("Generating RSA-4096 self-signed certificate ...");
    const result = await generateCert({
      certPath: cfg.certPath,
      keyPath: cfg.keyPath,
      commonName: cfg.mailbox,
    });
    thumbprint = result.thumbprintSha256;
  }

  printErrLine("\n--- Upload to Entra ---");
  printErrLine(`In the app registration ${cfg.clientId}:`);
  printErrLine("  Certificates & secrets → Certificates → Upload certificate");
  printErrLine(`  File to upload (PUBLIC cert only): ${cfg.certPath}`);
  printErrLine(`  SHA-256 thumbprint: ${thumbprint}`);
  printErrLine(`  Keep the private key ${cfg.keyPath} local (chmod 600). Do NOT upload it.`);
  return "done";
}

async function stepRenderHandoff(): Promise<StepResult> {
  const cfg = await loadConfig();
  const thumbprint = certThumbprintSha256(await Bun.file(cfg.certPath).text());
  const pack = await renderAdminPack(cfg, thumbprint);
  printErrLine("\n--- Admin handoff pack rendered ---");
  printErrLine(`  ${pack.ps1Path}`);
  printErrLine(`  ${pack.adminMdPath}`);
  printErrLine("Send ADMIN.md (and setup-admin.ps1) to your Exchange/Entra admin.");
  printErrLine("Re-run `emissary init` after they finish to verify the setup.");
  return "done";
}

/** Shared shape for a verify gate: run a probe, mark done on pass, block otherwise. */
async function verifyGate(
  name: OnboardingStep,
  run: (graph: Graph, cfg: Config) => Promise<{ status: string; detail: string }>,
  opts: { blockOnWarn?: boolean } = {},
): Promise<StepResult> {
  const cfg = await loadConfig();
  const graph = await Graph.create(cfg);
  const check = await run(graph, cfg);
  printErrLine(`  [${check.status.toUpperCase()}] ${name}: ${check.detail}`);
  if (check.status === "pass") return "done";
  if (check.status === "skip" && !opts.blockOnWarn) {
    printErrLine(`  (continuing — but the '${name}' guarantee is unverified)`);
    return "done";
  }
  return "blocked";
}

const STEP_RUNNERS: Record<OnboardingStep, (ctx: Ctx) => Promise<StepResult>> = {
  prereqs: () => stepPrereqs(),
  collect: (ctx) => stepCollect(ctx),
  cert: () => stepCert(),
  "render-handoff": () => stepRenderHandoff(),
  "verify-token": () => verifyGate("verify-token", async (_g, cfg) => (await probeToken(cfg)).check),
  "verify-read": () => verifyGate("verify-read", (g, cfg) => probeRead(g, cfg)),
  "verify-negative": () => verifyGate("verify-negative", (g, cfg) => probeNegative(g, cfg)),
  "verify-allowlist": () => verifyGate("verify-allowlist", (g, cfg) => probeAllowlist(g, cfg)),
  finish: () => stepFinish(),
};

async function stepFinish(): Promise<StepResult> {
  const cfg = await loadConfig();
  const { runDoctor } = await import("./doctor.ts");
  const checks = await runDoctor(cfg);
  const failed = checks.filter((c) => c.status === "fail");
  printErrLine("\n=== Security posture ===");
  printErrLine(`  mailbox: ${cfg.mailbox} (shared, no interactive sign-in)`);
  printErrLine("  auth: app-only, certificate credential (no secrets, no refresh tokens)");
  printErrLine("  access: Exchange RBAC scopes the app to this mailbox only");
  printErrLine("  outbound: allowlist preflight + transport rule (no override)");
  for (const c of checks) printErrLine(`  [${c.status.toUpperCase()}] ${c.name}: ${c.detail}`);
  if (failed.length > 0) {
    printErrLine("Some checks failed — see above. Not marking onboarding complete.");
    return "blocked";
  }
  return "done";
}

// --------------------------------------------------------------------------
// Entry
// --------------------------------------------------------------------------

export async function initCommand(args: string[]): Promise<number> {
  const p = parseArgs(args, ["config"]);
  const configFile = strFlag(p, "config");
  const interactive = !configFile && Boolean(process.stdin.isTTY);
  const state = await loadOnboarding();

  // Non-interactive: ingest and persist the supplied config, satisfying collect.
  if (configFile) {
    const raw = await Bun.file(configFile).json();
    // validateConfig fills default cert/key paths when the file omits them.
    const cfg = validateConfig(raw);
    await saveConfig(cfg);
    await markStep(state, "collect", "done");
  }

  const ctx: Ctx = { state, interactive };

  for (const step of ONBOARDING_STEPS) {
    if (stepStatus(state, step) === "done") continue;
    const result = await STEP_RUNNERS[step](ctx);
    if (result === "blocked") {
      printJson({
        ok: false,
        paused: step,
        message: `onboarding paused at "${step}" — resolve the item above and re-run \`emissary init\``,
        completed: ONBOARDING_STEPS.filter((s) => stepStatus(state, s) === "done"),
      });
      return 1;
    }
    await markStep(state, step, "done");
  }

  printJson({ ok: true, onboarding: "complete", steps: ONBOARDING_STEPS });
  return 0;
}
