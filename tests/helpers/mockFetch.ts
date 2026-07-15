/**
 * A tiny fetch mock for offline Graph tests.
 *
 * Install a list of routes; each intercepted request is matched (by method +
 * url predicate) to the first route that fits and answered with a canned
 * Response. All requests are recorded so tests can assert on them. No network.
 */

export interface MockRoute {
  method?: string;
  match: (url: string) => boolean;
  status?: number;
  json?: unknown;
  text?: string;
}

export interface RecordedRequest {
  method: string;
  url: string;
  body: string | undefined;
  headers: Record<string, string>;
}

export interface MockHandle {
  requests: RecordedRequest[];
  restore: () => void;
}

export function installMockFetch(routes: MockRoute[]): MockHandle {
  const original = globalThis.fetch;
  const requests: RecordedRequest[] = [];

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) headers[k] = v;
    }
    requests.push({ method, url, body: typeof init?.body === "string" ? init.body : undefined, headers });

    const route = routes.find((r) => (r.method ?? "GET").toUpperCase() === method && r.match(url));
    if (!route) {
      return new Response(
        JSON.stringify({ error: { code: "notMocked", message: `no route for ${method} ${url}` } }),
        {
          status: 404,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    const status = route.status ?? 200;
    if (route.text !== undefined) {
      return new Response(route.text, { status });
    }
    return new Response(JSON.stringify(route.json ?? {}), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  return {
    requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** A throwaway config for tests (paths/ids are never dereferenced offline). Full capabilities by default. */
export const TEST_CONFIG = {
  tenantId: "contoso.onmicrosoft.com",
  clientId: "11111111-2222-3333-4444-555555555555",
  mailbox: "agent@contoso.com",
  capabilities: { move: true, send: true },
  allowlistGroup: "emissary-allowed@contoso.com",
  certPath: "/tmp/emissary-test.crt",
  keyPath: "/tmp/emissary-test.key",
  negativeTestMailbox: "ceo@contoso.com",
} as const;
