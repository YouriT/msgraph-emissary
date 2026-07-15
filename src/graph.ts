/**
 * The one and only Microsoft Graph HTTP layer.
 *
 * Every request in Emissary goes through here. This is where two whole classes
 * of predecessor bug are structurally prevented:
 *
 *   - JSON injection: request bodies are ALWAYS `JSON.stringify` of a typed
 *     object. Callers pass objects, never strings; there is no string-concat
 *     path to a body.
 *   - Path/param injection: URL path segments go through `encodeURIComponent`
 *     (via the path builders below) and query params through URLSearchParams.
 *     Callers must use `usersPath()` / `segs()` rather than interpolating.
 *
 * Uses Bun's built-in `fetch` — no axios. Errors are thrown as `GraphHttpError`
 * carrying the status so probes (e.g. doctor's negative test) can branch on it.
 */

import { getToken } from "./auth.ts";
import { redact } from "./output.ts";
import type { Config, GraphCollection, GraphError } from "./types.ts";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export class GraphHttpError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = "GraphHttpError";
    this.status = status;
    this.code = code;
  }
}

/**
 * Percent-encode each path segment and join with "/". This is the ONLY
 * sanctioned way to build a Graph path from dynamic values.
 */
export function segs(...parts: string[]): string {
  return parts.map((p) => encodeURIComponent(p)).join("/");
}

/** Build a `/users/{mailbox}/...rest` path with every segment encoded. */
export function usersPath(mailbox: string, ...rest: string[]): string {
  return `/${segs("users", mailbox, ...rest)}`;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** Typed body — serialized with JSON.stringify. Never a pre-built string. */
  body?: unknown;
  /** Query params — serialized with URLSearchParams (handles encoding). */
  query?: Record<string, string | number | boolean | undefined>;
  /** Extra headers (e.g. Prefer for immutable ids). */
  headers?: Record<string, string>;
}

function buildUrl(path: string, query?: RequestOptions["query"]): string {
  const url = new URL(GRAPH_BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

const GRAPH_HOST = new URL(GRAPH_BASE).host;

/** Refuse to send the bearer token anywhere but Graph, even via a server-supplied link. */
function assertGraphHost(url: string): void {
  const host = new URL(url).host;
  if (host !== GRAPH_HOST) {
    throw new Error(`refusing to follow non-Graph link (host "${host}") with a bearer token`);
  }
}

/** A Graph client bound to one token + config for the lifetime of a command. */
export class Graph {
  private constructor(
    private readonly token: string,
    readonly cfg: Config,
  ) {}

  /** Mint a token (in-memory) and return a bound client. */
  static async create(cfg: Config): Promise<Graph> {
    const token = await getToken(cfg);
    return new Graph(token, cfg);
  }

  /** Build a client with an explicit token, bypassing auth. For tests only. */
  static withToken(token: string, cfg: Config): Graph {
    return new Graph(token, cfg);
  }

  /** Raw fetch — returns the Response without throwing on non-2xx. Used by
   *  probes that must inspect the status code (e.g. the 403 negative test). */
  async raw(path: string, opts: RequestOptions = {}): Promise<Response> {
    const method = opts.method ?? "GET";
    // Caller headers first so Authorization/Accept below always win — a caller
    // can add headers (e.g. ConsistencyLevel) but never override auth.
    const headers: Record<string, string> = {
      ...opts.headers,
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    };
    let bodyText: string | undefined;
    if (opts.body !== undefined) {
      bodyText = JSON.stringify(opts.body);
      headers["Content-Type"] = "application/json";
    }
    return fetch(buildUrl(path, opts.query), { method, headers, body: bodyText });
  }

  /** Perform a request and parse JSON, throwing GraphHttpError on non-2xx. */
  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    const res = await this.raw(path, opts);
    if (!res.ok) {
      throw await toHttpError(res);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (text.length === 0) return undefined as T;
    return JSON.parse(text) as T;
  }

  get<T>(path: string, query?: RequestOptions["query"], headers?: Record<string, string>): Promise<T> {
    return this.request<T>(path, {
      method: "GET",
      ...(query ? { query } : {}),
      ...(headers ? { headers } : {}),
    });
  }

  post<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    return this.request<T>(path, {
      method: "POST",
      ...(body !== undefined ? { body } : {}),
      ...(headers ? { headers } : {}),
    });
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: "PATCH", body });
  }

  /**
   * Follow @odata.nextLink until `limit` items are collected. nextLink is an
   * absolute Graph URL; we fetch it directly (still with our auth header), but
   * only after confirming it still points at Graph — the bearer token must
   * never be sent to a non-Graph host, even from a server-supplied link.
   */
  async paged<T>(path: string, query?: RequestOptions["query"], limit = 100): Promise<T[]> {
    const out: T[] = [];
    let url: string | undefined = buildUrl(path, query);
    while (url && out.length < limit) {
      assertGraphHost(url);
      const res: Response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: "application/json" },
      });
      if (!res.ok) throw await toHttpError(res);
      const page = (await res.json()) as GraphCollection<T>;
      out.push(...page.value);
      url = page["@odata.nextLink"];
    }
    return out.slice(0, limit);
  }
}

/** Convert a failed Response into a redaction-safe GraphHttpError. */
async function toHttpError(res: Response): Promise<GraphHttpError> {
  let code: string | undefined;
  let message = `${res.status} ${res.statusText}`;
  try {
    const parsed = (await res.json()) as GraphError;
    if (parsed.error?.code) code = parsed.error.code;
    if (parsed.error?.message) message = `${res.status}: ${parsed.error.message}`;
  } catch {
    // non-JSON body; keep the status line
  }
  return new GraphHttpError(res.status, code, redact(message));
}
