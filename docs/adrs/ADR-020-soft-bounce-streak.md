# ADR-020: Soft-Bounce Streaks — counting transient failures without over-reacting

## Status

Accepted — 2026-07-27. Extends [ADR-018](ADR-018-suppression-scope.md).

## Context

Transient bounces were **discarded entirely**. `parseProviderEvent` matched permanent types and
returned `null` for everything else, so a `Transient` or `SoftBounce` webhook left no trace: no event,
no outcome change, not even a dedupe-log entry, and no log line. A subscriber could soft-bounce on
twenty consecutive campaigns and the database would be byte-identical to one who received all twenty.

The original reasoning was sound as far as it went — a soft bounce is temporary (full mailbox,
greylisting, a server down for an hour), and one is not a reason to stop mailing someone. What that
reasoning missed is **what Postmark has already done before it tells us.**

Postmark retries internally. When a mailbox provider defers a message, Postmark re-attempts delivery
on its own schedule (their documented example: another try ~10 minutes later, which often succeeds).
A `SoftBounce`/`Transient` webhook fires **only once Postmark has given up** — in their words, when
the status shows a soft bounce, "Postmark has ceased attempting to send that message." It does not
deactivate the address, so the next campaign starts a fresh retry cycle.

So a soft-bounce webhook does not mean "a hiccup." It means **a whole retry cycle failed.** That is a
meaningfully strong signal, and discarding it threw away the only evidence we get about mailboxes that
are dying rather than dead. It also means no retry logic belongs in cablegram — Postmark is far better
placed to do it, and already has.

It is still not *proof* the mailbox is gone: inboxes drain and servers come back. So the useful unit is
not the event but the **streak**.

## Decision

### 1. Transient bounces are normalized, not dropped

A new `soft-bounce` event type, from Postmark's transient classifications (`Transient`, `SoftBounce`,
`DnsError`, `SMTPApiError`, `InboundError`, `TemplateRenderingFailed`, `ChallengeVerification`,
`VirusNotification`, `OpenRelayTest`, `Unknown`).

`AutoResponder` is excluded from **both** the permanent and transient sets: an out-of-office reply is
not a delivery failure at all — the mail arrived.

### 2. A consecutive-streak counter on the subscription

`Subscription` gains `consecutiveSoftBounces`. A soft bounce increments it; **any delivery resets it to
zero**; a re-subscribe clears it, because an old streak is not evidence against a revived membership.

At `SOFT_BOUNCE_THRESHOLD` (default **3**) the membership is marked `bounced` for that newsletter.

The threshold is low deliberately. Each soft bounce already represents a failed retry cycle, so three
of them is three campaigns' worth of attempts — a dead mailbox by any reasonable reading. An earlier
draft of this decision suggested 5, on the mistaken assumption that a single soft bounce was
near-meaningless.

The counter lives on the **subscription**, not in `deliverability`, because it is an observation about
*this newsletter's* sends. It is also why no new aggregate was needed.

### 3. It never reaches the global suppression list

At threshold, the membership becomes `bounced` **for that newsletter only**. No global suppression.

This follows directly from ADR-018's axis. A hard bounce is a *mailbox* fact — the address does not
exist, provably, for everyone. A soft-bounce streak is strong evidence but not proof, and it is
evidence gathered by **one publication**. Escalating it to a global verdict would infer a mailbox-level
fact from one newsletter's observations, which is exactly the over-reach ADR-018 corrected.

A genuinely dead mailbox will accumulate its own streak on every newsletter that mails it, and each
will reach the same conclusion independently. That is slower, and it is the price of the independence
the whole model rests on.

### 4. A `soft-bounced` recipient outcome

`OUTCOME_STATUSES` gains `soft-bounced`, ranked **above `delivered`** and below `bounced`. Without it a
send report would show `accepted` for someone who demonstrably never received the message.

The two are mutually exclusive in practice — Postmark either eventually delivers (Delivery webhook, no
bounce) or gives up (SoftBounce webhook, no delivery) — but if both ever arrive, "we stopped trying" is
the truthful outcome and must not be overwritten. `CampaignStats` gains a matching `softBounced` bucket.

## Consequences

- **Dying mailboxes are now visible**, both as a per-send outcome and as a per-newsletter status. This
  was previously invisible in every form.
- **One extra write per delivered recipient.** Resetting the streak means a write on delivery — ~18k
  per send. It is mitigated by `recordDelivery` returning `false` when there is nothing to clear, so
  the overwhelmingly common path skips the write entirely; and it is a small targeted update, not a
  read-modify-write of a large document (ADR-019). It is still a real cost, accepted because
  "consecutive" is not meaningful without a reset.
- **The feature is quiet until it has data.** A threshold of 3 needs three sends to an address before it
  can fire. There is no history to seed it from — soft bounces were discarded, and nothing has been sent
  yet, so a backfill from Postmark's 45-day bounce retention would recover nothing. The counter simply
  starts working after a few campaigns.
- **A serial soft-bouncer stays reachable on other newsletters** until each accumulates its own streak.
  Named rather than hidden; it is the deliberate consequence of §3.
- **No retry logic in cablegram.** Postmark already retried before the webhook fired; adding our own
  would be duplicative and worse-placed.
- **Bad-actor detection remains deferred** and is now decoupled from this work. It needs an
  address-keyed counter that outlives the subscription row — a different shape from this one, which
  needed no new aggregate.

## Related

- [ADR-018](ADR-018-suppression-scope.md) — the global-vs-per-newsletter axis this applies
- [ADR-008](ADR-008-email-delivery-postmark.md) — the webhook path
- [ADR-019](ADR-019-per-recipient-outcome-documents.md) — the outcome record gaining `soft-bounced`
- [Postmark: how to fix soft bounces](https://postmarkapp.com/support/article/1159-how-to-fix-soft-bounces) — the retry behaviour this rests on
