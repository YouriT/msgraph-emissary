# Emissary

A governed Microsoft 365 mailbox identity for AI agents. Emissary gives an agent
its **own** Exchange Online shared mailbox — with explicit permissions and hard
guardrails — instead of borrowing a person's account. It talks to Microsoft Graph
app-only, authenticated by a certificate, and never touches `/me`.

> Built on the pattern from Ned Bellavance's "How to Set Up an Exchange Online
> Mailbox for an autonomous agent." Replaces a personal-mailbox skill that used
> delegated user auth, a plaintext client secret, and injection-prone shell code.

## Getting started

There are two roles: the **operator** (you — runs this CLI, holds the private
key on their machine) and an **Exchange Online + Entra admin** (grants
permissions and runs Exchange RBAC commands; may or may not be the same
person as the operator).

### Prerequisites

- [Bun](https://bun.sh) ≥ 1.1 — `curl -fsSL https://bun.sh/install | bash`
- `openssl` on `PATH` (preinstalled on macOS and Ubuntu)
- A single-tenant Entra **app registration with no client secret**. If you
  don't have one yet: Entra → *App registrations* → New registration →
  *Single tenant*. Note the **Application (client) ID** and your **Tenant ID**
  — `init` will ask for both. (Many orgs let any user register an app; consent
  to permissions is what's admin-gated, in step 4 below.)
- A shared mailbox (e.g. `agent@contoso.com`) — no license, no interactive
  sign-in. Ask your admin to create one if it doesn't exist:
  `New-Mailbox -Shared -Name "Agent Mailbox" -PrimarySmtpAddress agent@contoso.com`
- **Only if this identity replies, forwards, or sends mail:** a mail-enabled
  group whose membership will be the outbound allowlist (e.g.
  `emissary-allowed@contoso.com`). Purely read-side identities don't need this
  at all — see **Capabilities** below.

### Capabilities

Reading and listing mail is always on — it's the point of the identity.
Everything else is an independent, deny-by-default toggle, and `init` asks
about each one directly. The toggles aren't a 1:1 mirror of Graph/Exchange
permissions — some share a role for reasons that aren't obvious upfront:

| Capability | Unlocks | Exchange RBAC role needed | Extra admin work |
|---|---|---|---|
| *(always on)* | `inbox`, `unread`, `search`, `read`, `folders`, `stats`, `attachments` | `Application Mail.Read` | none |
| `markRead` | `read`'s mark-as-read side effect, plus `mark` (explicit read/unread) | upgrades to `Application Mail.ReadWrite` (it's a write) | none |
| `download` | `download` (saving attachment bytes to disk) | stays on `Application Mail.Read` — reading bytes isn't a write | none |
| `move` | `move` (between folders, incl. `archive`) | upgrades to `Application Mail.ReadWrite` | none |
| `copy` | `copy` (duplicate into another folder) | upgrades to `Application Mail.ReadWrite` | none |
| `delete` | `delete` | upgrades to `Application Mail.ReadWrite` | none |
| `categorize` | `categorize` (add/remove Outlook categories) | upgrades to `Application Mail.ReadWrite` | none |
| `flag` | `flag` (follow-up: flagged/complete/notFlagged) | upgrades to `Application Mail.ReadWrite` | none |
| `importance` | `importance` (low/normal/high) | upgrades to `Application Mail.ReadWrite` | none |
| `focus` | `focus` (Focused/Other reclassification) | upgrades to `Application Mail.ReadWrite` | none |
| `send` | `send` (compose new mail) | adds `Application Mail.Send` | allowlist group + transport rule |
| `reply` | `reply` | adds `Application Mail.Send` | allowlist group + transport rule |
| `forward` | `forward` | adds `Application Mail.Send` | allowlist group + transport rule |

Two things worth calling out: `markRead`, `move`, `copy`, `delete`,
`categorize`, `flag`, `importance`, and `focus` are eight separate toggles an
operator may want independently, but every one of them PATCHes (or deletes)
the mailbox, so **all eight share the same `Mail.ReadWrite` role** — enabling
any one of them is what triggers the upgrade from `Mail.Read`, not any
particular combination. And `send`/`reply`/`forward` are three separate
toggles (e.g. "can reply to threads but never cold-send") even though all
three need only `Mail.Send` — any one of them enabled pulls in the allowlist
group and transport rule. `archive` isn't its own capability: Graph treats
"Archive" as a well-known folder, so `move <id> --to archive` already works
under the `move` capability.

Say no to everything except reading during `init` for a fully **read-only**
identity: no allowlist group, no transport rule, and the admin only ever
grants `Mail.Read` — the smallest possible footprint. Commands outside the
enabled capabilities refuse immediately with a clear error, before any Graph
call is attempted.

### 1. Get the binary

Download the prebuilt binary for your platform from the
[latest release](https://github.com/YouriT/msgraph-emissary/releases/latest) —
no clone or build required:

```bash
# macOS (Apple Silicon) — swap in emissary-darwin-x64 for Intel Macs,
# emissary-linux-x64 / emissary-linux-arm64 for Ubuntu
curl -LO https://github.com/YouriT/msgraph-emissary/releases/latest/download/emissary-darwin-arm64
chmod +x emissary-darwin-arm64
mv emissary-darwin-arm64 ./emissary
```

Each release also publishes a `.sha256` checksum alongside the binary if you
want to verify the download.

Prefer to build from source instead (or need a version between releases)?

```bash
git clone git@github.com:YouriT/msgraph-emissary.git
cd msgraph-emissary
bun install
bun run build          # -> dist/emissary (single binary)
```

Or skip the build and run from source during setup: `bun run dev init`.

(The rest of this guide says `./emissary`; if you built from source, that's
`./dist/emissary`.)

### 2. Run the onboarding wizard

```bash
./emissary init
```

This is a **resumable, interactive wizard** — safe to interrupt and re-run.
Each time, it picks up at the first incomplete step:

1. **Prereqs** — checks `openssl` is on `PATH` and that Microsoft's login/Graph
   endpoints are reachable.
2. **Collect** — prompts for tenant ID, client ID, mailbox address, then asks
   about each capability (markRead, download, move, copy, delete, categorize,
   flag, importance, focus, send, reply, forward) in turn. The allowlist group
   address is only asked if you enable send, reply, or forward. Finally, an
   optional "negative test" mailbox the app should *never* be able to reach.
3. **Cert** — generates an RSA-4096 self-signed certificate locally and prints
   exactly what to upload to Entra (file + SHA-256 thumbprint). The private
   key never leaves your machine.
4. **Render handoff** — writes a filled-in `setup-admin.ps1` + `ADMIN.md` under
   `~/.config/emissary/admin/` with your real values already substituted in.
   **Send those two files to your Exchange/Entra admin** and stop here.

At this point `init` will report it's paused waiting on the admin. That's expected.

### 3. Hand off to your admin

Send them `ADMIN.md` (it explains everything, including the one command they
need to run: `setup-admin.ps1`, which is idempotent). They'll need to:

- Confirm the app registration and uploaded certificate,
- Grant admin consent for the Graph application permissions listed in `ADMIN.md`,
- Find the **Enterprise Application Object ID** (not the client ID, not the app
  registration's own Object ID — see the pitfall callout in
  [`references/setup.md`](references/setup.md)) and paste it into the script,
- Run `setup-admin.ps1` (creates the Exchange service principal, tags the
  mailbox, and scopes the RBAC role assignment(s) — plus the allowlist group
  and transport rule, only if send, reply, or forward is enabled).

### 4. Re-run to verify

```bash
./emissary init
```

Once the admin is done, re-running `init` resumes from where it left off and
**verifies each admin-dependent step live** — token acquisition, a real mailbox
read, the negative test (must come back `403`), and (if send, reply, or
forward is enabled) allowlist resolution — never assuming success. It finishes
with a one-screen security posture summary.

You can also jump straight to the self-test at any time:

```bash
./emissary doctor
```

Non-interactive setup (e.g. CI/config-management) is supported via
`emissary init --config file.json`, using the same verification gates —
see the `Config` fields in [`src/types.ts`](src/types.ts) for the required shape.

### 5. Use it

```bash
./emissary inbox
./emissary send --to approved@contoso.com --subject "hi" --body "..."  # only if send is enabled
```

To give an **agent** this mailbox identity, point it at [`SKILL.md`](SKILL.md) —
it documents the commands, the allowlist behavior, and the untrusted-content
rules the agent must follow when reading email.

Config lives at `$XDG_CONFIG_HOME/emissary/config.json` (default
`~/.config/emissary/`); onboarding state at `$XDG_STATE_HOME/emissary/`
(default `~/.local/state/emissary/`). See
[`references/setup.md`](references/setup.md) for the full manual walkthrough
if you'd rather not use the wizard, or need to understand exactly what it
automates.

## The security model: two independent planes

Emissary keeps **who the agent can reach** and **who the agent can email**
separate, so a mistake in one cannot widen the other.

### Plane 1 — Mailbox access (can it read/write *this* mailbox, and *only* this one?)

| Control | What it does |
|---|---|
| **Shared mailbox** | No license, no interactive sign-in. There is no user to phish. |
| **Certificate-only app** | Single-tenant Entra app, certificate credential. **No client secrets, no delegated flows, no refresh tokens.** The private key stays local (`chmod 600`); only the public cert is uploaded. |
| **App-only tokens** | Minted per invocation, in memory, never written to disk, never printed. There is no `token get` command. |
| **Exchange RBAC for Applications** | A management scope on a mailbox custom attribute + role assignment(s) — `Application Mail.Read` (always), upgraded to `Mail.ReadWrite` if `move` or `markRead` is enabled, plus `Mail.Send` if `send`/`reply`/`forward` is enabled — constrain the app to the one tagged mailbox and to only the roles it actually needs. This is the modern replacement for the deprecated Application Access Policies. |
| **Negative test** | `doctor` actively proves the boundary: it tries to read a mailbox it should *not* reach and expects a `403`. A `200` is a hard failure. |

### Plane 2 — Outbound control (who can the agent email?)

Only present at all when send, reply, or forward is enabled — an identity
without any of the three has no allowlist group, no transport rule, and no
`Mail.Send` permission to begin with.

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

## Development

```bash
bun test           # mocked-Graph unit tests (no network)
bun run typecheck  # strict tsc
bun run lint       # biome check (lint + format check + import order)
bun run lint:fix   # biome check --write
```

Runtime dependencies: `@azure/msal-node` only. Biome is a dev-only tool (lint/format), not shipped.
