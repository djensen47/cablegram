# ADR-029: Unsubscribe Handling — who owns the link, cablegram or the provider

## Status

Accepted — 2026-11-02. **Implemented** the same day. Amends [ADR-015](ADR-015-public-token-unsubscribe.md)
(its per-recipient `List-Unsubscribe` header is no longer unconditional) and
[ADR-027](ADR-027-library-entrypoint.md) (an unset `BASE_URL` is no longer a silent hazard — it is a
startup error under the default mode).

## Context

[ADR-015](ADR-015-public-token-unsubscribe.md) built cablegram's own unsubscribe: an HMAC token per
`(newsletter, subscription)`, an open `/v1/unsubscribe`, and a per-recipient RFC 8058
`List-Unsubscribe` header on every send. Its goals included the human link at the foot of a
newsletter, but that link was dropped: a campaign is one Bulk call with a **shared** body (ADR-008),
so the per-recipient token could only travel in the header.

What ADR-015 never recorded is what the provider does on the other side. Pinned against Postmark's
support docs (articles 1208 and 1299) and its Message Streams API:

- **A broadcast stream manages unsubscribes itself by default**
  (`SubscriptionManagementConfiguration.UnsubscribeHandlingType: Postmark`). Every message must carry
  an unsubscribe link; when the body has no `{{{ pm:unsubscribe }}}` placeholder, Postmark **appends
  one** to the footer. It adds its own `List-Unsubscribe` headers, which "cannot be edited" in this
  mode, and it suppresses whoever clicks — **per stream**.
- **Managing them yourself (`Custom`) needs Postmark's approval**, and then requires "your own visible
  unsubscribe link to the body of every message" plus your own headers. cablegram cannot meet the
  body-link requirement today, for the shared-body reason above.

So on a stock Postmark account, a send carried *two* unsubscribe mechanisms — Postmark's footer link
and cablegram's header — with no documented answer for what Postmark does with ours. And a reader who
used Postmark's link stopped receiving mail while cablegram still showed them `subscribed`: the opt-out
arrives as a `SubscriptionChange` webhook, which cablegram recorded as unhandled (ADR-021). That
divergence is not cosmetic. cablegram is meant to be the record of who opted out (ADR-018, ADR-023);
if it isn't, moving to another provider would re-mail people who had left.

Separately, ADR-015 made an unset `BASE_URL` **silently omit** the header from every campaign.
ADR-027 then listed that as a host hazard rather than fixing it.

The pressure on the decision: the first real send is close, and waiting on Postmark's approval *and*
building a per-recipient body link before it would hold the launch for a mechanism Postmark already
provides.

## Decision

### 1. `UNSUBSCRIBE_HANDLING`: `cablegram` | `provider`

A new env setting chooses who owns the unsubscribe link in a campaign.

| | `cablegram` (default) | `provider` |
|---|---|---|
| `List-Unsubscribe` headers | cablegram's, per recipient (ADR-015) | **none** from cablegram |
| Visible link | none today (see Consequences) | the provider's |
| Where an opt-out lands | `POST /v1/unsubscribe` | the provider's webhook → cablegram |
| `BASE_URL` | **required** | optional |

The value names the **role**, not the vendor. `DeliveryGateway` is pluggable (ADR-008), and
`postmark` as a value would read wrong behind any other adapter.

The default is `cablegram` so an existing deployment's sends are unchanged. cablegram's own
mechanism is kept whole under `provider` — the route, the page and the token still exist — so
switching back is a config change plus whatever the provider requires.

### 2. Under `provider`, cablegram sends no unsubscribe headers

`unsubscribeHeaders()` returns nothing. It is the one function the real send and the test send share
(ADR-025), so both obey the setting and a proof still shows what subscribers get. Two competing sets
of `List-Unsubscribe` headers would leave it to each mail client which opt-out it honours, and one of
them would never reach the provider's list.

### 3. The provider's opt-out is recorded as a per-newsletter unsubscribe

`parseProviderEvent` now claims Postmark's `SubscriptionChange`:

| Payload | Result |
|---|---|
| `SuppressSending: true`, `SuppressionReason: ManualSuppression`, `Origin: Recipient` | new `unsubscribed` event |
| `SuppressionReason: HardBounce` or `SpamComplaint` | **ignored** — the same occurrence arrives as its own `Bounce` / `SpamComplaint` webhook, which is what cablegram acts on |
| `SuppressSending: false` (a reactivation) | unhandled: `SubscriptionChange:Reactivation` |
| anything else | unhandled: `SubscriptionChange:<reason>:<origin>` |

`RecordDeliveryEvents` resolves the `Tag` (the campaign id) to its newsletter, exactly as for a bounce,
and calls the domain's `subscription.unsubscribe()` on **that newsletter's** membership. It never
touches the global suppression list (ADR-018 — an opt-out is a fact about a relationship), and it never
changes the recipient's delivery outcome: the mail was delivered or it wasn't, and an opt-out does not
revise that.

The `ManualSuppression` + `Recipient` pairing is deliberately narrow. Postmark's docs list the reason
and origin values without saying which one a footer click produces, so this is the reading that means
"the recipient did it" and no wider. If a real opt-out arrives labelled differently, it lands in
`GET /v1/webhooks/unhandled` under its own key instead of being guessed at — and the first real send
should be checked for exactly that. Reactivations carry no `Tag`, and an operator suppression made in
Postmark's UI (`Customer`/`Admin`) is not the subscriber's act, so neither is applied.

### 4. `BASE_URL` is required when cablegram owns the link

Under `cablegram`, a missing `BASE_URL` is now a **startup error** that names both ways out (set it, or
choose `provider`). The header is the only opt-out cablegram offers in that mode, so a deployment that
sends without it should not start.

### 5. Running under `provider` with Postmark

Operational steps, recorded here because none of them is visible to the code:

1. The broadcast stream's `UnsubscribeHandlingType` is `Postmark` (the default).
2. The broadcast stream's webhook has **Subscription Change** enabled, pointing at
   `/webhooks/postmark`. Without it, opt-outs never reach cablegram.
3. Campaign bodies carry **no** `{{{ pm:unsubscribe }}}`: cablegram renders bodies through Handlebars
   against an empty model (ADR-024), which blanks it, and Postmark then appends its default link.

## Consequences

- **Launch needs neither Postmark's approval nor a per-recipient body.** The visible link required on
  a broadcast stream — and by CAN-SPAM — is Postmark's.
- **Opt-outs are per stream at Postmark, and every newsletter shares the one `broadcast` stream**
  (hardcoded in the Postmark adapter). Under `provider`, leaving one newsletter therefore stops mail
  from all of them, which contradicts ADR-018. cablegram's own records stay per-newsletter, but
  Postmark's suppression is what blocks the mail. **This must be resolved before a second newsletter
  sends under `provider`** — a stream per newsletter is the likely shape.
- **A re-subscribe may stay blocked.** `Subscribe` revives the row, but Postmark keeps suppressing the
  address. Postmark's Suppressions API allows deletes, but its docs do not say whether a
  recipient-origin suppression can be deleted, so this is unresolved.
- **The link's placement and wording are Postmark's**, appended to the footer, because the placeholder
  cannot survive cablegram's renderer.
- **A proof can now unsubscribe its recipient at Postmark.** Under `provider` a test send carries
  Postmark's link too, and clicking it suppresses that address on the stream. cablegram ignores the
  resulting webhook (the `test:<id>` tag is not a campaign, ADR-025), so ADR-025's "proof-mailing
  yourself can't unsubscribe you" holds only under `cablegram`.
- **The consent record is thinner for these opt-outs** (ADR-023). `unsubscribedAt` is when cablegram
  processed the webhook, not Postmark's `ChangedAt` — normally seconds apart, longer if Postmark
  retried — and there is no IP or user agent, because the caller is Postmark.
- **Breaking:** a deployment with no `BASE_URL` and the default mode no longer starts.
- **Returning to `cablegram` on Postmark** means Postmark approval, switching the stream to `Custom`,
  and a visible per-recipient link in the body. The Bulk API's per-message `TemplateModel`
  ("recipient-specific content" substituted into the shared body) looks like the way to carry one
  without giving up the single Bulk call, but its docs only show it in the subject line. That is a
  future decision, and it is the same per-recipient rendering question ADR-024 left open.

## Related

- [ADR-008](ADR-008-email-delivery-postmark.md) — the pluggable `DeliveryGateway`; why the setting is
  named for the role.
- [ADR-015](ADR-015-public-token-unsubscribe.md) — cablegram's own unsubscribe, now one of two modes.
- [ADR-018](ADR-018-suppression-scope.md) — an opt-out is per-newsletter, never global.
- [ADR-021](ADR-021-unhandled-webhook-events.md) — where an unclaimed `SubscriptionChange` lands.
- [ADR-023](ADR-023-consent-record.md) — the consent record these opt-outs write to.
- [ADR-024](ADR-024-custom-fields.md) — per-recipient rendering, the open question behind a body link.
- [ADR-025](ADR-025-campaign-test-send.md) — the test send shares `unsubscribeHeaders()`.
- [ADR-027](ADR-027-library-entrypoint.md) — the `BASE_URL` hazard this turns into a startup error.
