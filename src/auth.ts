/**
 * App-only authentication via certificate credential.
 *
 * We use @azure/msal-node's ConfidentialClientApplication with a certificate
 * credential. MSAL owns the client-assertion JWT (signing, x5c header, expiry) —
 * we never hand-roll JWT. There are NO client secrets, NO delegated flows, and
 * NO refresh tokens: app-only client-credential tokens are short-lived access
 * tokens minted fresh per process. We keep the token in memory only and never
 * write it to disk or print it.
 */

import { X509Certificate } from "node:crypto";
import { ConfidentialClientApplication, LogLevel } from "@azure/msal-node";
import type { Config } from "./types.ts";

const GRAPH_DEFAULT_SCOPE = "https://graph.microsoft.com/.default";

/**
 * Compute the hex SHA-256 thumbprint of a PEM certificate, matching what Entra
 * stores when the cert is uploaded. `fingerprint256` is colon-delimited upper
 * hex (e.g. "AB:CD:..."); MSAL wants continuous lower/upper hex.
 */
export function certThumbprintSha256(certPem: string): string {
  const fp = new X509Certificate(certPem).fingerprint256; // "AB:CD:.."
  return fp.replace(/:/g, "");
}

let cachedClient: ConfidentialClientApplication | undefined;
let cachedClientKey: string | undefined;

/**
 * Build (and memoize within this process) the MSAL confidential client from
 * config + on-disk cert material. Reads the private key and public cert from
 * the paths in config; the private key stays in memory.
 */
async function getClient(cfg: Config): Promise<ConfidentialClientApplication> {
  const key = `${cfg.tenantId}|${cfg.clientId}|${cfg.certPath}|${cfg.keyPath}`;
  if (cachedClient && cachedClientKey === key) return cachedClient;

  const certFile = Bun.file(cfg.certPath);
  const keyFile = Bun.file(cfg.keyPath);
  if (!(await certFile.exists())) {
    throw new Error(`certificate not found at ${cfg.certPath} — run \`emissary init\``);
  }
  if (!(await keyFile.exists())) {
    throw new Error(`private key not found at ${cfg.keyPath} — run \`emissary init\``);
  }
  const certPem = await certFile.text();
  const privateKey = await keyFile.text();

  const client = new ConfidentialClientApplication({
    auth: {
      clientId: cfg.clientId,
      authority: `https://login.microsoftonline.com/${cfg.tenantId}`,
      clientCertificate: {
        thumbprintSha256: certThumbprintSha256(certPem),
        privateKey,
        x5c: certPem,
      },
    },
    system: {
      loggerOptions: {
        // Never log Personal/Organizational Info, and swallow MSAL's own logs so
        // no token or assertion can escape to the terminal.
        piiLoggingEnabled: false,
        logLevel: LogLevel.Error,
        loggerCallback: () => {},
      },
    },
  });
  cachedClient = client;
  cachedClientKey = key;
  return client;
}

/**
 * Acquire an app-only Graph access token. In-memory only; callers must never
 * print or persist it. Throws a redaction-safe error on failure.
 */
export async function getToken(cfg: Config): Promise<string> {
  const client = await getClient(cfg);
  let result: Awaited<ReturnType<typeof client.acquireTokenByClientCredential>>;
  try {
    result = await client.acquireTokenByClientCredential({ scopes: [GRAPH_DEFAULT_SCOPE] });
  } catch (err) {
    // MSAL errors can carry correlation info but not the token; still, keep the
    // message generic and let output.redact() scrub anything unexpected.
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`token acquisition failed: ${msg}`);
  }
  if (!result?.accessToken) {
    throw new Error("token acquisition returned no access token");
  }
  return result.accessToken;
}

/** Reset the memoized client (used by tests). */
export function _resetAuthCacheForTests(): void {
  cachedClient = undefined;
  cachedClientKey = undefined;
}
