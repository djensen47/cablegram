# ADR-031: Confirmation and System Channels — every email names its stream

## Status

Accepted — 2026-11-05. **Implemented** the same day. Amends [ADR-030](ADR-030-sending-channels.md):
its single transactional stream is split in two, and `sendingChannel` is renamed `campaignChannel`.

## Context

[ADR-030](ADR-030-sending-channels.md) gave each newsletter its own campaign stream but sent **all**
transactional mail — subscription confirmations and account mail alike — through one configured
stream, `POSTMARK_TRANSACTIONAL_STREAM`. That replaced the old hardcoded `outbound` one-for-one
instead of asking which mail belongs on which stream, and it quietly capped cablegram at one
transactional stream on a Postmark server that can carry several.

Cablegram sends two kinds of transactional mail, and they belong to different owners:

- **Subscription confirmations** belong to a newsletter. They are sent from its From address.
- **Account mail** — password reset and magic-link login (ADR-013/014) — goes to cablegram's own
  users and belongs to no newsletter.

Postmark streams also have a **type** (Transactional, Broadcasts, Inbound), and Postmark asks that
one-off transactional mail go through a Transactional stream and bulk mail through a Broadcasts one;
the two run on separate sending infrastructure. That rules out sending confirmations through the
campaign stream, for a reason specific to cablegram as well as Postmark's: Postmark suppresses
**per stream**, so on the campaign stream someone who once unsubscribed could never receive the
confirmation for a re-signup, and under Postmark-managed unsubscribes (ADR-029) the confirmation would
carry an Unsubscribe footer.

## Decision

### 1. `Newsletter.confirmationChannel` — required, per newsletter

A newsletter names the provider channel its subscription confirmations go through. For Postmark, the
ID of a Transactional-type stream. Same rules as the campaign channel (ADR-030 §1): required on
create, changeable, never cleared, validated loosely, not checked against Postmark.

Per newsletter rather than one shared stream, because Postmark blocks hard bounces and spam complaints
on Transactional streams too: on a shared confirmation stream, a complaint about one newsletter's
confirmation would block that address's confirmations for every newsletter. Per newsletter keeps that
as separate as cablegram's own records (ADR-018). The cost — two streams per newsletter against
Postmark's 10-per-server limit — is accepted for now; a global fallback for newsletters that set no
confirmation channel is the obvious relief if the limit bites.

A newsletter created before the field existed reads it as `null` (no migration, as ADR-030 §2). A
**double opt-in** signup to it is refused — `SubscriptionConfirmationChannelMissingError`, a 409 that
names the fix — **before** the subscription is created or revived, so there is never a `pending` row
that no email will confirm. A **single opt-in** signup sends no mail and is unaffected.

### 2. `sendingChannel` is renamed `campaignChannel` — and the old name keeps working

With two channels on a newsletter, "sending" no longer says which. The rename is everywhere (domain,
stored field, API, CLI), and the 3.1.0 name is kept working:

- a stored `sendingChannel` is **read** as `campaignChannel`, so a channel set under 3.1.0 carries
  over; the next write replaces the document without it;
- the API still accepts `sendingChannel` on create and update, and the CLI `--sending-channel`, as
  deprecated aliases. Both names with **different** values is refused (400 / usage error) rather than
  guessed.

### 3. `SYSTEM_EMAIL_CHANNEL` for account mail — and the old variable keeps working

Account mail goes through `SYSTEM_EMAIL_CHANNEL`. It is configuration rather than newsletter data
because account mail belongs to no newsletter, and it sits beside `SYSTEM_EMAIL_FROM_ADDRESS`, which
already sets that mail's sender. The name avoids "transactional" (a Postmark stream *type*) and
"stream" (Postmark's word); "channel" matches the newsletter fields.

`POSTMARK_TRANSACTIONAL_STREAM` is still accepted **for account mail only** when `SYSTEM_EMAIL_CHANNEL`
is unset; the new name wins when both are set. Startup logs one `deprecated_config` line whenever the
old name is present, and the old name goes at the next major version. It is deliberately **not** a
fallback for confirmations: that would make `confirmationChannel` optional and bring back exactly the
shared confirmation stream §1 rejects.

### 4. Every email names its channel

`BulkMessage.sendingChannel` is required on **every** message, not only broadcasts. The category now
only picks the signing token (broadcast vs transactional server token). The Postmark adapter holds no
stream configuration at all and uses the channel verbatim as `MessageStream`.

## Consequences

- Each newsletter can keep its campaign and confirmation mail on separate streams of the right type,
  and account mail on a third — Postmark's model, with no stream ID assumed anywhere.
- A newsletter needs two streams, so roughly four newsletters fit on one Postmark server.
- Released as a minor version (3.2.0), like ADR-030's change. Upgrade steps: set
  `confirmationChannel` on each existing newsletter before double opt-in signups to it work; rename
  `POSTMARK_TRANSACTIONAL_STREAM` to `SYSTEM_EMAIL_CHANNEL` when convenient.
- Double opt-in is still incomplete (the confirmation email carries an API path, not a usable link),
  so in practice no confirmation reaches a subscriber yet. This decides where it will go once it does.

## Related

- [ADR-013](ADR-013-authentication-user-accounts.md) / [ADR-014](ADR-014-passwordless-magic-link-login.md)
  — the account mail `SYSTEM_EMAIL_CHANNEL` carries.
- [ADR-018](ADR-018-suppression-scope.md) — complaints are per newsletter; a confirmation stream per
  newsletter keeps Postmark agreeing.
- [ADR-029](ADR-029-unsubscribe-handling.md) — Postmark-managed unsubscribes, which would footer a
  confirmation sent on a Broadcasts stream.
- [ADR-030](ADR-030-sending-channels.md) — the campaign channel this renames and extends.
