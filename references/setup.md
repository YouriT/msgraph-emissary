# Emissary — end-to-end setup

This is the full manual walkthrough behind `emissary init`. Two people are
involved: the **operator** (runs the CLI, holds the private key) and an
**Exchange Online + Entra admin** (creates scopes, consents to permissions).
`emissary init` automates the operator side and renders a filled-in
`setup-admin.ps1` + `ADMIN.md` for the admin — this doc explains what each step
means and how to do it by hand.

---

## 0. Choose capabilities (operator)

Listing/viewing mail is always on — it's the point of the identity. Everything
past that is an independent, deny-by-default toggle, and it changes what the
rest of this walkthrough actually requires. The toggles are NOT a 1:1 mirror of
Graph/Exchange permissions:

| Capability | Unlocks | Exchange RBAC role needed | Extra admin work |
|---|---|---|---|
| *(always on)* | `inbox`/`unread`/`search`/`read`/`folders`/`stats`/`attachments` | `Application Mail.Read` | none |
| `markRead` | marking read when `read` views a message, plus `mark` | upgrades to `Application Mail.ReadWrite` | none |
| `download` | `download` (attachment bytes to disk) | stays on `Application Mail.Read` | none |
| `move` | `move` (incl. `--to archive`) | upgrades to `Application Mail.ReadWrite` | none |
| `copy` | `copy` | upgrades to `Application Mail.ReadWrite` | none |
| `delete` | `delete` | upgrades to `Application Mail.ReadWrite` | none |
| `categorize` | `categorize` | upgrades to `Application Mail.ReadWrite` | none |
| `flag` | `flag` | upgrades to `Application Mail.ReadWrite` | none |
| `importance` | `importance` | upgrades to `Application Mail.ReadWrite` | none |
| `focus` | `focus` | upgrades to `Application Mail.ReadWrite` | none |
| `send` | `send` | adds `Application Mail.Send` | allowlist group (step 7) + transport rule |
| `reply` | `reply` | adds `Application Mail.Send` | allowlist group (step 7) + transport rule |
| `forward` | `forward` | adds `Application Mail.Send` | allowlist group (step 7) + transport rule |

`markRead`, `move`, `copy`, `delete`, `categorize`, `flag`, `importance`, and
`focus` all share one role (every one of them writes the mailbox) even though
they're eight separate toggles — enabling any single one is what triggers the
upgrade from `Mail.Read` to `Mail.ReadWrite`. `download` doesn't need write
access at all despite being gated. `send`/`reply`/`forward` are separate
toggles that all need only `Mail.Send` — any one of them enabled requires step
7 in full. There's no separate "archive" capability: Graph treats "Archive" as
a well-known folder, so `move --to archive` already works under `move`.

An identity with everything off except viewing skips step 7 entirely, only
ever needs `Mail.Read` granted in step 4, and never sees an allowlist. The
examples below show the **full** (every capability on) case; drop what you
don't need.

## 1. Create the shared mailbox (admin)

```powershell
New-Mailbox -Shared -Name "Agent Mailbox" -DisplayName "Agent" -PrimarySmtpAddress agent@contoso.com
# Ensure interactive sign-in stays disabled (shared mailboxes have no license).
```

A shared mailbox has no license and no interactive sign-in — there is no user
credential to steal.

## 2. Register the Entra application (operator, then admin consent)

1. Entra → **App registrations** → New registration → single tenant. Note the
   **Application (client) ID**.
2. **No client secret.** Emissary uses a certificate only. If a secret exists,
   delete it.

## 3. Generate and upload the certificate (operator)

```bash
# What `emissary init` runs for you (argv array, no shell interpolation):
openssl req -x509 -newkey rsa:4096 -sha256 -nodes -days 730 \
  -keyout ~/.config/emissary/emissary.key \
  -out    ~/.config/emissary/emissary.crt \
  -subj "/CN=Emissary agent@contoso.com"
chmod 600 ~/.config/emissary/emissary.key
```

Upload **only the public cert** (`emissary.crt`) in Entra → your app →
*Certificates & secrets → Certificates*. Keep the private key local. Confirm the
SHA-256 thumbprint in Entra matches the one `init` printed.

## 4. Grant Graph application permissions (admin consent)

Entra → your app → **API permissions** → add the permissions for the
capabilities you chose in step 0, then **Grant admin consent**:

| Permission | Needed for | Why Emissary needs it |
|---|---|---|
| `Mail.Read` | always | Read messages in the mailbox (narrowed by RBAC in step 6). |
| `Mail.ReadWrite` | any of `move`, `markRead`, `copy`, `delete`, `categorize`, `flag`, `importance`, `focus` | Write access to the mailbox — supersedes `Mail.Read` above; grant one or the other, not both. |
| `Mail.Send` | `send`, `reply`, or `forward` | Send/reply/forward from the mailbox (narrowed by RBAC). |
| `Group.Read.All` | `send`, `reply`, or `forward` | Look up the allowlist group by its mail address. |
| `GroupMember.Read.All` | `send`, `reply`, or `forward` | Read the group's transitive membership (the allowlist). |
| `User.ReadBasic.All` | `send`, `reply`, or `forward` | Resolve member users' email/UPN. |
| `OrgContact.Read.All` | `send`, `reply`, or `forward` | Resolve mail-contact members of the group. |

> Whichever Mail.* permission you grant is tenant-wide *until* the Exchange
> RBAC scope in step 6 restricts it to the single mailbox. Do both.

## 5. ⚠️ The Object-ID pitfall (read this before step 6)

`New-ServicePrincipal` in Exchange needs the **Enterprise Application (service
principal) Object ID** — and there are three similar-looking GUIDs that are easy
to confuse:

| GUID | Where | Use it here? |
|---|---|---|
| **Application (client) ID** | App registration → Overview → "Application (client) ID" | Used as `-AppId`, and as Emissary's `clientId`. **Not** the ObjectId. |
| **App registration Object ID** | App registration → Overview → "Object ID" | ❌ Never used for `New-ServicePrincipal`. |
| **Enterprise Application Object ID** | **Enterprise applications** → your app → Overview → "Object ID" | ✅ This is `-ObjectId` for `New-ServicePrincipal`. |

The Enterprise Application (a.k.a. the service principal) is created when the app
is registered / consented in the tenant. If you paste the app registration's
Object ID (or the client ID) into `-ObjectId`, `New-ServicePrincipal` fails or
creates a principal that never matches at token time.

## 6. Exchange RBAC for Applications (admin — this is `setup-admin.ps1`)

```powershell
Connect-ExchangeOnline -Organization contoso.onmicrosoft.com

# 6a. Map the app into Exchange (see step 5 for which Object ID!)
New-ServicePrincipal -AppId <CLIENT_ID> -ObjectId <ENTERPRISE_APP_OBJECT_ID> -DisplayName "Emissary agent"

# 6b. Tag the target mailbox so the scope can match it
Set-Mailbox -Identity agent@contoso.com -CustomAttribute15 "emissary-agent"

# 6c. Management scope: matches ONLY mailboxes carrying that tag
New-ManagementScope -Name "Emissary-agent-Scope" -RecipientRestrictionFilter "CustomAttribute15 -eq 'emissary-agent'"

# 6d. Scoped role assignment(s) — the app's Mail.* now apply to the tagged mailbox only.
#     Pick the role(s) matching step 0's capability choice:
#       view-only (nothing else enabled)                              -> "Application Mail.Read" only
#       any of move/markRead/copy/delete/categorize/flag/importance/focus -> "Application Mail.ReadWrite" instead of Mail.Read
#       send, reply, or forward enabled                               -> also add "Application Mail.Send"
New-ManagementRoleAssignment -Name "Emissary-agent-ApplicationMailReadWrite" -App <CLIENT_ID> -Role "Application Mail.ReadWrite" -CustomResourceScope "Emissary-agent-Scope"
New-ManagementRoleAssignment -Name "Emissary-agent-ApplicationMailSend"      -App <CLIENT_ID> -Role "Application Mail.Send"      -CustomResourceScope "Emissary-agent-Scope"
```

**Do not use Application Access Policies** — they are deprecated. Exchange RBAC
for Applications (above) is the supported mechanism.

## 7. Allowlist group + transport rule (admin) — only if send, reply, or forward is enabled

```powershell
# Outbound allowlist: membership = who Emissary may email
New-DistributionGroup -Name "emissary-allowed@contoso.com" -PrimarySmtpAddress emissary-allowed@contoso.com -Type Security
Add-DistributionGroupMember -Identity emissary-allowed@contoso.com -Member partner@example.com

# Hard outbound enforcement, independent of the client
New-TransportRule -Name "Emissary-Outbound-agent" `
  -From agent@contoso.com `
  -ExceptIfSentToMemberOf emissary-allowed@contoso.com `
  -RejectMessageReasonText "Emissary is permitted to email approved recipients only."
```

## 8. Verify (operator)

```bash
emissary doctor
```

`doctor` acquires a token, reads the target mailbox, runs the **negative test**
(reading a mailbox it must not reach — expects `403`, if a negative-test
mailbox was configured), and — only if send, reply, or forward is enabled —
resolves the allowlist. All green means the configured capabilities are
enforced as scoped.

## Notes

- **202 ≠ delivered.** `send` returning submitted means Graph accepted it for
  delivery. Bounces come back as an NDR in `agent@contoso.com`'s inbox.
- **Rotating the cert:** generate a new one, upload it, remove the old cert from
  Entra. The thumbprint in `config.json`-adjacent cert changes; no secret rotation.
