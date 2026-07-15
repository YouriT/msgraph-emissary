#!/usr/bin/env bun

/**
 * Emissary CLI entry point.
 *
 * `emissary <command> [args]`. Each command is an async handler returning a
 * process exit code. All output is JSON on stdout; human progress goes to
 * stderr. A single top-level try/catch converts any thrown error into a uniform
 * (redacted) JSON error object so an agent always gets parseable output.
 */

import { GraphHttpError } from "./graph.ts";
import { errorResult, printErrLine, printJson } from "./output.ts";

type Handler = (args: string[]) => Promise<number>;

/** Lazily-imported command handlers keep startup fast for the common path. */
const COMMANDS: Record<string, () => Promise<Handler>> = {
  doctor: async () => (await import("./commands/doctor.ts")).doctorCommand,
  init: async () => (await import("./commands/init.ts")).initCommand,
  inbox: async () => (await import("./commands/inbox.ts")).inboxCommand,
  unread: async () => (await import("./commands/unread.ts")).unreadCommand,
  search: async () => (await import("./commands/search.ts")).searchCommand,
  read: async () => (await import("./commands/read.ts")).readCommand,
  send: async () => (await import("./commands/send.ts")).sendCommand,
  reply: async () => (await import("./commands/reply.ts")).replyCommand,
  forward: async () => (await import("./commands/forward.ts")).forwardCommand,
  attachments: async () => (await import("./commands/attachments.ts")).attachmentsCommand,
  download: async () => (await import("./commands/download.ts")).downloadCommand,
  folders: async () => (await import("./commands/folders.ts")).foldersCommand,
  move: async () => (await import("./commands/move.ts")).moveCommand,
  stats: async () => (await import("./commands/stats.ts")).statsCommand,
  allowlist: async () => (await import("./commands/allowlist.ts")).allowlistCommand,
};

const USAGE = `emissary <command> [args]

Setup:
  init                     Resumable onboarding wizard (cert, admin pack, verification)
  doctor                   Self-test: token, mailbox read, negative test, allowlist

Read:
  inbox [--top N] [--folder NAME]
  unread [--top N]
  search --query "..." [--top N]
  read <id>
  folders
  stats
  attachments <id>
  download <id> <name> [--out DIR]
  move <id> --to FOLDER

Send (always runs the allowlist preflight; no override flag exists):
  send --to a@x --subject "..." --body "..." [--cc b@x]
  reply <id> --body "..."
  forward <id> --to a@x [--comment "..."]

Governance:
  allowlist                Show the resolved allowlist members
`;

async function main(): Promise<number> {
  const [, , command, ...rest] = process.argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printErrLine(USAGE);
    return command ? 0 : 1;
  }

  const loader = COMMANDS[command];
  if (!loader) {
    printJson(errorResult(`unknown command: ${command}`, "run `emissary help` for usage"));
    return 1;
  }

  const handler = await loader();
  return handler(rest);
}

try {
  process.exit(await main());
} catch (err) {
  if (err instanceof GraphHttpError) {
    printJson(errorResult(`graph error (HTTP ${err.status})`, err.message));
  } else {
    printJson(errorResult(err instanceof Error ? err.message : String(err)));
  }
  process.exit(1);
}
