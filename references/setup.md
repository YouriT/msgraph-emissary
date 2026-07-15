# Emissary — end-to-end setup

This is the full manual walkthrough behind `emissary init`. Two people are
involved: the **operator** (runs the CLI, holds the private key) and an
**Exchange Online + Entra admin** (creates scopes, consents to permissions).
`emissary init` automates the operator side and renders a filled-in
`setup-admin.ps1` + `ADMIN.md` for the admin — this doc explains what each step
means and how to do it by hand.

---

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

Entra → your app → **API permissions** → add these **Application** permissions,
then **Grant admin consent**:

| Permission | Why Emissary needs it |
|---|---|
| `Mail.ReadWrite` | Read/move/mark messages in the mailbox (narrowed by RBAC in step 6). |
| `Mail.Send` | Send/reply/forward from the mailbox (narrowed by RBAC). |
| `Group.Read.All` | Look up the allowlist group by its mail address. |
| `GroupMember.Read.All` | Read the group's transitive membership (the allowlist). |
| `User.ReadBasic.All` | Resolve member users' email/UPN. |
| `OrgContact.Read.All` | Resolve mail-contact members of the group. |

> `Mail.ReadWrite` / `Mail.Send` are tenant-wide *until* the Exchange RBAC scope
> in step 6 restricts them to the single mailbox. Do both.

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

# 6d. Scoped role assignments — the app's Mail.* now apply to the tagged mailbox only
New-ManagementRoleAssignment -Name "Emissary-agent-ApplicationMailReadWrite" -App <CLIENT_ID> -Role "Application Mail.ReadWrite" -CustomResourceScope "Emissary-agent-Scope"
New-ManagementRoleAssignment -Name "Emissary-agent-ApplicationMailSend"      -App <CLIENT_ID> -Role "Application Mail.Send"      -CustomResourceScope "Emissary-agent-Scope"
```

**Do not use Application Access Policies** — they are deprecated. Exchange RBAC
for Applications (above) is the supported mechanism.

## 7. Allowlist group + transport rule (admin)

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
(reading a mailbox it must not reach — expects `403`), and resolves the
allowlist. All green means both planes are enforced.

## Notes

- **202 ≠ delivered.** `send` returning submitted means Graph accepted it for
  delivery. Bounces come back as an NDR in `agent@contoso.com`'s inbox.
- **Rotating the cert:** generate a new one, upload it, remove the old cert from
  Entra. The thumbprint in `config.json`-adjacent cert changes; no secret rotation.
