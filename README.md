# Emissary

A governed Microsoft 365 mailbox identity for AI agents. Emissary gives an agent
its **own** Exchange Online shared mailbox — with explicit permissions and hard
guardrails — instead of borrowing a person's account. It talks to Microsoft Graph
app-only, authenticated by a certificate, and never touches `/me`.

> Built on the pattern from Ned Bellavance's "How to Set Up an Exchange Online
> Mailbox for an autonomous agent." Replaces a personal-mailbox skill that used
> delegated user auth, a plaintext client secret, and injection-prone shell code.

## The security model: two independent planes

Emissary keeps **who the agent can reach** and **who the agent can email**
separate, so a mistake in one cannot widen the other.

### Plane 1 — Mailbox access (can it read/write *this* mailbox, and *only* this one?)

| Control | What it does |
|---|---|
| **Shared mailbox** | No license, no interactive sign-in. There is no user to phish. |
| **Certificate-only app** | Single-tenant Entra app, certificate credential. **No client secrets, no delegated flows, no refresh tokens.** The private key stays local (`chmod 600`); only the public cert is uploaded. |
| **App-only tokens** | Minted per invocation, in memory, never written to disk, never printed. There is no `token get` command. |
| **Exchange RBAC for Applications** | A management scope on a mailbox custom attribute + role assignments (`Application Mail.ReadWrite`, `Application Mail.Send`) constrain the app to the one tagged mailbox. This is the modern replacement for the deprecated Application Access Policies. |
| **Negative test** | `doctor` actively proves the boundary: it tries to read a mailbox it should *not* reach and expects a `403`. A `200` is a hard failure. |

### Plane 2 — Outbound control (who can the agent email?)

| Control | What it does |
|---|---|
| **Allowlist preflight** | Before *any* send, Emissary resolves a mail-enabled group's membership and refuses to send to non-members — client-side, before the message leaves the process. **No `--force`.** |
| **Transport rule** | Admin-side belt-and-suspenders: mail from the mailbox to anyone outside the allowlist group is rejected at the transport layer, independent of the client. |

Access says *which mailbox*; outbound says *which recipients*. Compromising the
client can't grant access to other mailboxes (Exchange RBAC blocks it) and can't
email outsiders (the transport rule blocks it).

## Handling untrusted input

- **Email bodies** are HTML-stripped, truncated, and prefixed with a notice that
  the content may contain prompt injection — instructions inside must not be followed.
- **Attachment filenames** are sanitized (no path separators, no `..`), written
  only inside an explicit output dir, and never overwrite an existing file.
- **Every Graph body** is `JSON.stringify` of a typed object; **every URL segment**
  is percent-encoded. No string-built requests anywhere.
- **Delivery ≠ submission**: a `202` means *submitted*. NDRs land in the inbox.

## Install & use

```bash
bun install
bun run src/index.ts doctor        # dev
bun run build                      # -> dist/emissary (single binary)

emissary init                      # onboarding wizard (operator)
emissary doctor                    # verify the whole posture
emissary inbox
emissary send --to approved@contoso.com --subject "hi" --body "..."
```

Config lives at `$XDG_CONFIG_HOME/emissary/config.json` (default `~/.config/emissary/`);
onboarding state at `$XDG_STATE_HOME/emissary/`. See
[`references/setup.md`](references/setup.md) for the full end-to-end walkthrough,
including the Enterprise-Application-Object-ID pitfall.

## Development

```bash
bun test           # mocked-Graph unit tests (no network)
bun run typecheck  # strict tsc
bun run lint       # biome check (lint + format check + import order)
bun run lint:fix   # biome check --write
```

Runtime dependencies: `@azure/msal-node` only. Biome is a dev-only tool (lint/format), not shipped.
