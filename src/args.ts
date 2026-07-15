/**
 * Minimal, dependency-free argv parsing for subcommands.
 *
 * Supports:
 *   --flag            → boolean true
 *   --key value       → string
 *   --key=value       → string
 *   -x                → boolean true (short)
 * Positional args are everything not consumed as a flag/value.
 *
 * Deliberately tiny — no external arg library (zero-runtime-deps rule).
 */

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/** Flags that take a value (so `--key value` consumes the next token). */
export function parseArgs(argv: string[], valueFlags: string[] = []): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const takesValue = new Set(valueFlags);

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok.startsWith("--")) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (takesValue.has(body) && i + 1 < argv.length) {
        flags[body] = argv[++i]!;
      } else {
        flags[body] = true;
      }
    } else if (tok.startsWith("-") && tok.length > 1) {
      flags[tok.slice(1)] = true;
    } else {
      positionals.push(tok);
    }
  }
  return { positionals, flags };
}

/** Read a flag as a string, or undefined if absent/boolean. */
export function strFlag(parsed: ParsedArgs, name: string): string | undefined {
  const v = parsed.flags[name];
  return typeof v === "string" ? v : undefined;
}

/** Read a flag as a number with a default. */
export function numFlag(parsed: ParsedArgs, name: string, def: number): number {
  const v = parsed.flags[name];
  if (typeof v === "string") {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return def;
}

/** Read a boolean flag. */
export function boolFlag(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags[name] === true || parsed.flags[name] === "true";
}
