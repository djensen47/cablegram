# ADR-030: Sending Channels — a newsletter names the stream it sends through

## Status

Accepted — 2026-11-03. **Implemented** the same day. Amends [ADR-008](ADR-008-email-delivery-postmark.md)
(the email port now carries a channel for broadcasts) and corrects
[ADR-029](ADR-029-unsubscribe-handling.md)'s claim that every newsletter shares one stream.
Amended by [ADR-031](ADR-031-confirmation-and-system-channels.md): `sendingChannel` is renamed
`campaignChannel` (the old name still works), confirmations get their own per-newsletter channel, and
§4's single `POSTMARK_TRANSACTIONAL_STREAM` is replaced by `SYSTEM_EMAIL_CHANNEL` for account mail.

## Context

Postmark routes every message through a **message stream**, and the sender names the stream on each
request (`MessageStream` on both the single-email and the Bulk API). A stream's ID is **chosen by the
operator** when the stream is created; Postmark documents no fixed name for a broadcast stream, and
its own API example calls one `broadcasts`.

cablegram had hardcoded two IDs anyway. The first Postmark adapter (#4) let a send name its stream and
fell back to `broadcast`; #20 replaced that option with a `category` and a fixed map —
`broadcast → 'broadcast'`, `transactional → 'outbound'` — with no configuration at all. Two
consequences followed, both found only when reasoning about a real account:

- **A server whose broadcast stream has any other ID cannot send a campaign.** Postmark rejects the
  request (`ErrorCode 1235`, "The stream provided does not exist on this server", HTTP 422), the
  campaign goes `failed`, and the API reports a generic 500. If a stream called `broadcast` *does*
  exist alongside the intended one, campaigns silently go there instead.
- **Every newsletter shared one stream, so under Postmark-managed unsubscribes (ADR-029) one opt-out
  stopped mail from all of them.** Postmark suppresses per stream. ADR-029 recorded this as a property
  of the setup; it was a property of the hardcoded map.

A newsletter is the natural owner of this fact. Which stream its campaigns go through is part of its
setup, the same as its From address, and one stream per newsletter is exactly what keeps Postmark's
opt-out list as separate as cablegram's own (ADR-018).

## Decision

### 1. `Newsletter.sendingChannel` — required, no default

A newsletter carries the provider channel its campaigns go through. For Postmark, that is the ID of a
broadcast message stream.

- **Required on create** (`POST /v1/newsletters`, `cablegram newsletters create --sending-channel`),
  with **no default** — cablegram cannot know the ID the operator chose.
- **Changeable, never clearable** (`PATCH`, `cablegram newsletters update <id> --sending-channel`). A
  newsletter without one cannot send, so there is no `null` to set it back to.
- **Validated loosely**: 1-100 characters, no whitespace. Postmark documents no ID rules, and a check
  stricter than the provider's would refuse real IDs.
- **Not checked against Postmark when set.** A wrong ID surfaces at the first test send as Postmark's
  "stream not found", which is cheap: a test send writes nothing (ADR-025).

### 2. Newsletters that predate the field read back as `null` — no migration

A stored newsletter without the field loads normally with `sendingChannel: null`. `PATCH` writes the
field onto the same document. `SendCampaign` and `SendTestCampaign` check for it immediately after
resolving the newsletter — **before** the send record, any outcome, or the `sending` transition — and
throw `CampaignSendingChannelMissingError`, surfaced as a **409** whose message names both fixes
(`PATCH /v1/newsletters/{id}` and the CLI command). The campaign is left exactly as it was.
`cablegram newsletters list` shows the channel, `(not set)` when missing, so the gap is visible before
a send rather than at one.

### 3. The email port carries the channel, for broadcasts only

`BulkMessage` becomes a union: a `broadcast` **must** carry `sendingChannel`; a `transactional` carries
none. The type makes a broadcast without a channel a compile error. The Postmark adapter uses the
channel verbatim as `MessageStream`.

This loosens a rule stated in `CLAUDE.md` — "the email port carries a business `category`, not a
Postmark stream". The rule's purpose survives: the port still names no vendor concept. The field is
**`sendingChannel`**, named for the role (as `UNSUBSCRIBE_HANDLING`'s values are, ADR-029), and it is
an operator-configured value the adapter interprets — a stream ID for Postmark, whatever the
equivalent is behind another `DeliveryGateway` (ADR-008). What stays forbidden is a provider stream
name baked into a caller.

### 4. Transactional mail: one required `POSTMARK_TRANSACTIONAL_STREAM`

Subscribe confirmations and account emails go through a single configured stream. It is global, not
per newsletter: account mail belongs to no newsletter, and a transactional stream has no opt-out list
that sharing could leak across newsletters. It is **required with no default** for the same reason as
the broadcast channel. It is Postmark-named, like `POSTMARK_SERVER_TOKEN`, because it is the Postmark
adapter's own configuration rather than domain data.

## Consequences

- **Each newsletter can have its own stream**, so under `UNSUBSCRIBE_HANDLING=provider` an opt-out
  from one newsletter no longer stops another — provided each has its own stream. Two newsletters
  given the *same* channel still share an opt-out list; that is now the operator's choice, not
  cablegram's.
- **Every stream must be on the one Postmark server** whose token is `POSTMARK_SERVER_TOKEN`. Postmark
  allows up to 10 streams per server, including the defaults (its pricing page lists different
  figures per plan, so the effective limit is unconfirmed).
- **Each broadcast stream needs its own webhook** pointing at `/webhooks/postmark`, with Subscription
  Change enabled under `provider` (ADR-029 §5). Nothing in cablegram can check this.
- **Upgrade steps:** set `POSTMARK_TRANSACTIONAL_STREAM`, which is required; pass `sendingChannel`
  to `POST /v1/newsletters`; and set it on every existing newsletter, which cannot send until it
  has one. Released as a minor version (3.1.0): 3.0.0 had no deployments to break.
- Postmark's rejection of a bad stream ID still reaches the API caller as a generic 500, with the real
  message only in the log line. Mapping `EmailDeliveryError` to a clear response is a separate change.

## Related

- [ADR-008](ADR-008-email-delivery-postmark.md) — the pluggable `DeliveryGateway`; the port now carries
  a channel for broadcasts.
- [ADR-018](ADR-018-suppression-scope.md) — opt-outs are per newsletter; a stream per newsletter makes
  Postmark agree.
- [ADR-025](ADR-025-campaign-test-send.md) — a test send uses the same channel, so it is where a wrong
  ID is found.
- [ADR-029](ADR-029-unsubscribe-handling.md) — Postmark-managed unsubscribes, whose shared-stream
  consequence this corrects.
