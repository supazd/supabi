# Email

Status: the first step (sections 1 to 9) is implemented: the SMTP settings, a test email and a function to send with. No feature sends email yet. Decided on 2026-11-08.

## 1. Why, and what this step covers

Several features wait on email:

- Password recovery and email invitations, which accounts lack today ([Deferred items](../backlog.md), "Gaps in the current implementation").
- Timed exports and subscriptions ([Exports](exports.md)).
- Alerts, later on.

None of them can work until an administrator has set up an email server, and how that server is set up does not depend on which of them comes first. This step therefore covers only what all of them share:

- The settings of the SMTP server, in System administration.
- A test email, so the administrator knows the settings work before any feature relies on them.
- A function in the backend to send one message, which those features will call.

How messages are queued, retried and logged depends on what is sent and who waits for it, so the first feature that sends email decides that (section 10).

## 2. Where the settings live

The settings are stored in the metadata database, one row per organization, and a system administrator changes them in "System administration → Email". There is no startup configuration for them and no override from environment variables, for the same reason as the system settings ([Startup configuration](configuration.md) 10.5): an override would let instances differ again.

S3 and Redis stay in the startup configuration ([Startup configuration](configuration.md) 10.6), but none of the reasons given there applies to an SMTP server:

| | S3 and Redis | SMTP server |
|---|---|---|
| Client | Built at startup, which also checks that the service can be reached | A connection is made for each message and closed after it |
| Changed while running | Old files stay in the old place; shared locks and counters would be split between two addresses | Nothing is left behind: the next message uses the new server |
| Shared by | The whole installation | One organization: with several organizations, each sends from its own address and perhaps its own server |
| Who changes it | Whoever deploys | An administrator, who wants to send a test at once |

The password is encrypted with `secret-key` before it is stored, like data source passwords and the API keys of AI providers.

## 3. Settings

| Setting | Column | When empty | Rules |
|---|---|---|---|
| SMTP server | `smtp_host` | Email is off | A host name or an IP address, without a scheme or port |
| Port | `smtp_port` | Follows the encryption: 587, 465 or 25 | 1 to 65535 |
| Encryption | `smtp_security` | Never empty; STARTTLS when nothing was saved | STARTTLS, SSL/TLS or None |
| Username | `smtp_username` | The server is used without signing in | |
| Password | `smtp_password` | | Sealed with `secret-key`; never returned |
| Sender address | `from_address` | | Required when a server is set |
| Sender name | `from_name` | `SupaBI` | At most 100 characters |

- **On and off**: email is on when a server and a sender address are both set. There is no separate switch. Clearing the server and saving turns email off, and the other values are kept for when it is turned on again.
- **Encryption**:
  - STARTTLS connects in plain text and then asks the server to encrypt. A server that does not offer it is an error. The connection is never continued unencrypted, because the password would then be sent in plain text.
  - SSL/TLS encrypts from the first byte, usually on port 465.
  - None is for a relay inside the network, usually on port 25. With None, a username cannot be saved (`email_auth_unencrypted`), so a password is never sent unencrypted.
- **Certificates** are verified against the trust store of the machine. There is no option to skip verification. A server with a certificate from an internal CA works once that CA is added to the trust store, for example with `SSL_CERT_FILE`.
- **Signing in**: when a username is set, a password must be set too (`email_password_required`). The mechanism is chosen from those the server offers, PLAIN first and then LOGIN. Microsoft Exchange, for one, offers LOGIN and not PLAIN. When the server offers neither, sending fails with `no_auth`.
- **Password**: as with the API key of an AI provider, a read says only whether a password is set. Left out of a save, the password stays as it is; an empty string removes it. Clearing the username removes the password too.
- **When it is read**: on every message, so a change applies at once on every instance. A message already being sent finishes with the settings it started with.
- **Timeouts** are fixed: 10 seconds to connect, the same as "Test connection" of a data source ([Startup configuration](configuration.md) 10.7), and 30 seconds for the whole message. A server that is that slow is almost certainly misconfigured or unreachable.

## 4. Sending

The package `internal/mail`:

- `Send(ctx, server, message)` sends one message and returns when the server has accepted it or refused it. It makes one attempt.
- `Configured(ctx, pool, key, orgID)` reads the organization's settings and opens the password. When email is off it returns `ErrNotConfigured`, which a feature uses to say email is not set up.
- A message has recipients, a subject, a plain-text body and an optional HTML body. With an HTML body it is sent as `multipart/alternative`, so mail clients that do not show HTML show the text instead. Bodies are UTF-8 and quoted-printable; the subject and the sender name are encoded for non-ASCII text (RFC 2047). Every message has a `Date` and a `Message-ID` on the sender's domain.
- Line breaks in the subject or the sender name are refused, so the headers of a message cannot be extended from outside. Every address is parsed before it is used.
- It uses `net/smtp` from the Go standard library, with LOGIN written in the package. No dependency is added.

When sending fails, the error names the stage that failed, with the server's own text:

| Stage | Meaning |
|---|---|
| `connect` | The server could not be reached |
| `tls` | The encrypted connection could not be set up, for example because the certificate is not trusted |
| `no_starttls` | The encryption is STARTTLS but the server does not offer it |
| `auth` | The server refused the username or password |
| `no_auth` | A username is set but the server offers neither PLAIN nor LOGIN |
| `sender` | The server refused the sender address |
| `recipient` | The server refused the recipient |
| `data` | The server refused the message itself |

## 5. Test email

The page has a part "Send a test email": a recipient, which starts as the administrator's own address, and a button.

- The test uses the values in the form, saved or not, so an administrator can try settings before saving them. A password left empty uses the stored one, the same as "Test connection" of a data source.
- There is one recipient.
- The message is in the interface language of the person who sends it (section 6). It says who sent it and through which server, so a recipient who did not expect it knows where it came from.
- On success the page says the server accepted the message and how long it took. Whether it reaches the inbox is up to the mail system after that, and the page says so: a message accepted may still end up as spam.
- On failure the page names the stage (section 4) in the reader's language and shows the server's own text beneath, which only system administrators see.

## 6. Server-side language pack

Content rendered on the server is in the language of its reader ([Architecture overview](architecture.md) 10.1). The test email is the first such content, so the backend gets a language pack:

- The package `internal/i18n` embeds one JSON file per language, `en-US.json` and `zh-CN.json`, the same names as the interface uses. A test checks that both files have the same keys and the same parameters in each text.
- The server does not know anyone's interface language yet: the interface keeps the choice in the browser, and the `locale` column of `users` is not used. The test request therefore carries the language of the page that sends it.
- The first feature that emails other people has to give the server each recipient's language. See [Deferred items](../backlog.md).

## 7. API, permissions and audit

| Endpoint | |
|---|---|
| `GET /system/email` | The settings, whether a password is set, and the defaults (the port of each encryption, the sender name) |
| `PUT /system/email` | Saves the settings as a whole |
| `POST /system/email/test` | Sends a test email with the settings in the request and reports how it went |

- Only a system administrator can call them.
- A failure to send is a successful response to the test that says what went wrong, like "Test connection". Settings that cannot be valid, such as a port out of range, are refused with 400, the same as on save.
- Audit, in the category System (`system`):
  - Saving records `email_settings.update`, with the values before and after. The password itself is never written: the details say only whether it changed.
  - A test records `email.test`, with the recipient and the server. A failed test is recorded as a failure with its stage: unlike other tests, it sends a message out of the system.

## 8. Page

"Email" (`/settings/system/email`) is added to the navigation of System administration, after "AI usage". Only a system administrator can see it.

- The layout is the same as "General" ([Startup configuration](configuration.md) 10.3): one column, each setting with its name on the left, the input on the right and the description beneath. There are three groups: "SMTP server", "Sender" and "Send a test email".
- At the top, a note says whether email is on. When it is off, the note says that a server and a sender address are needed.
- The port's placeholder is the default of the chosen encryption. The password shows that one is set; a checkbox removes it, the same as the API key of an AI provider.
- Saving is possible only when something has changed; with unsaved changes, leaving the page asks for confirmation first. A test does not need the changes to be saved.

## 9. Secret key

The email password is one of the secrets `secret-key` seals ([Startup configuration](configuration.md) 11):

- The check at startup, when there is no check value yet, may try the email password like any other stored secret.
- `clear-secrets` clears it with the others and counts it in what it reports. The settings stay, and an administrator enters the password again.

## 10. Not in this step

| Item | Why deferred | When to re-evaluate |
|---|---|---|
| A queue, retries and a record of sent messages | Whether a message is sent at once or later, how often it is retried and who sees that it failed depend on what is sent: a password reset has someone waiting for it, a subscription does not | With the first feature that sends email |
| Attachments | Only subscriptions and timed exports need them, and their size limit depends on the export limits | With subscriptions |
| HTML templates and a layout shared by all messages | No message is designed yet | With the first feature that sends email |
| OAuth 2.0 sign-in (`XOAUTH2`) for Microsoft 365 and Gmail | Needs an application registered with the provider and a token refreshed in the background | When an organization's mail provider no longer accepts a password |
| Skipping certificate verification | It would let anyone on the network read the password. An internal CA can be added to the trust store instead | When a deployment cannot change its trust store |
| A sender per workspace | One sender for the organization is enough while nothing is sent from a workspace | When workspaces send subscriptions under their own names |
| Knowing the recipient's language on the server | See section 6 | With the first feature that emails other people |
| A `Reply-To` address | Nothing is sent that someone would answer | When a message is sent on behalf of a person |
