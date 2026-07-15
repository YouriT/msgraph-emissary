/**
 * Self-signed certificate generation via the OpenSSL CLI.
 *
 * We shell out to `openssl`, but ALWAYS with an argv array (Bun.spawn), never a
 * shell string — so there is no interpolation/injection surface (the exact class
 * of bug that plagued the bash predecessor). The private key is written 0600.
 *
 * Pure-JS X.509 generation is deliberately avoided: it needs a third-party lib
 * (breaks the zero-extra-deps rule) or homegrown ASN.1 (forbidden).
 */

import { chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { certThumbprintSha256 } from "./auth.ts";

export interface CertResult {
  certPath: string;
  keyPath: string;
  thumbprintSha256: string;
  subject: string;
}

/**
 * Sanitize a value for use inside an OpenSSL `-subj` DN component. Even though
 * argv passing prevents shell injection, `/` and `=` and control chars would
 * corrupt DN parsing, so strip them.
 */
function sanitizeDnValue(value: string): string {
  return value
    .replace(/[/\\=\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True if `openssl` is on PATH and runnable. */
export async function opensslAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["openssl", "version"], { stdout: "pipe", stderr: "pipe" });
    const code = await proc.exited;
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * Generate an RSA-4096 self-signed certificate + private key at the given paths.
 * Overwrites nothing implicitly beyond the two target files (caller decides).
 */
export async function generateCert(opts: {
  certPath: string;
  keyPath: string;
  /** Common Name for the cert subject — typically the mailbox address. */
  commonName: string;
  /** Validity in days (default ~2 years). */
  days?: number;
}): Promise<CertResult> {
  const cn = sanitizeDnValue(opts.commonName) || "emissary";
  const subject = `/CN=Emissary ${cn}`;
  const days = String(opts.days ?? 730);

  await mkdir(dirname(opts.keyPath), { recursive: true, mode: 0o700 });
  await mkdir(dirname(opts.certPath), { recursive: true, mode: 0o700 });

  const args = [
    "req",
    "-x509",
    "-newkey",
    "rsa:4096",
    "-sha256",
    "-nodes", // no passphrase on the key (it's protected by file perms)
    "-days",
    days,
    "-keyout",
    opts.keyPath,
    "-out",
    opts.certPath,
    "-subj",
    subject,
  ];

  const proc = Bun.spawn(["openssl", ...args], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`openssl failed (exit ${code}): ${err.trim()}`);
  }

  // Lock down the private key immediately; the cert may stay world-readable.
  await chmod(opts.keyPath, 0o600);
  await chmod(opts.certPath, 0o644).catch(() => {});

  const certPem = await Bun.file(opts.certPath).text();
  return {
    certPath: opts.certPath,
    keyPath: opts.keyPath,
    thumbprintSha256: certThumbprintSha256(certPem),
    subject,
  };
}
