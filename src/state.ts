/**
 * Onboarding state (resumable `emissary init`).
 *
 * A tiny JSON file under $XDG_STATE_HOME/emissary/onboarding.json records which
 * setup steps have completed, so re-running `init` resumes at the first
 * incomplete step instead of starting over. This is *not* secret material, but
 * the state dir is created 0700 anyway.
 */

import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { ensureStateDir, stateDir } from "./config.ts";
import type { OnboardingState, OnboardingStep, StepStatus } from "./types.ts";

/** Canonical ordered step list — single source of truth for wizard traversal. */
export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  "prereqs",
  "collect",
  "cert",
  "render-handoff",
  "verify-token",
  "verify-read",
  "verify-negative",
  "verify-allowlist",
  "finish",
] as const;

export function onboardingPath(): string {
  return join(stateDir(), "onboarding.json");
}

function emptyState(): OnboardingState {
  return { version: 1, updatedAt: new Date().toISOString(), steps: {} };
}

/** Read onboarding state, returning a fresh empty state if none exists yet. */
export async function loadOnboarding(): Promise<OnboardingState> {
  const file = Bun.file(onboardingPath());
  if (!(await file.exists())) return emptyState();
  try {
    const parsed = (await file.json()) as OnboardingState;
    if (parsed && typeof parsed === "object" && parsed.version === 1 && parsed.steps) {
      return parsed;
    }
  } catch {
    // fall through to a fresh state on any corruption
  }
  return emptyState();
}

/** Persist onboarding state (0600). */
export async function saveOnboarding(state: OnboardingState): Promise<void> {
  await ensureStateDir();
  state.updatedAt = new Date().toISOString();
  const path = onboardingPath();
  await Bun.write(path, `${JSON.stringify(state, null, 2)}\n`);
  await chmod(path, 0o600).catch(() => {});
}

export function stepStatus(state: OnboardingState, step: OnboardingStep): StepStatus {
  return state.steps[step] ?? "pending";
}

/** Mark a step done and persist. */
export async function markStep(
  state: OnboardingState,
  step: OnboardingStep,
  status: StepStatus,
): Promise<void> {
  state.steps[step] = status;
  await saveOnboarding(state);
}

/** The first step that is not yet done, or undefined if onboarding is complete. */
export function nextStep(state: OnboardingState): OnboardingStep | undefined {
  return ONBOARDING_STEPS.find((s) => stepStatus(state, s) !== "done");
}
