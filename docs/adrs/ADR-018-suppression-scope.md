# ADR-018: Suppression Scope — Global for Mailbox Facts, Per-Newsletter for Consent

## Status

Accepted — 2026-07-27. Supersedes the "suppression is the only cross-newsletter fact" clause of
[ADR-011](ADR-011-bounded-contexts.md).

## Context

cablegram's founding rule is that **one newsletter is independent of another**
([ADR-011](ADR-011-bounded-contexts.md)): subscriptions are flat and per-newsletter, the same address
in two newsletters is two independent rows, and there is no cross-newsletter `Contact` identity.

Suppression was the stated exception. ADR-011 called `deliverability` *"**global, address-keyed**
sending hygiene"* and concluded *"the only cross-newsletter fact we track by address is suppression."*
So the Postmark webhook pushed **both** hard bounces and spam complaints onto one global deny list.

That is wrong for complaints, and it is wrong in a way that contradicts the founding rule. A spam
complaint says *"I don't want mail from this publication."* Treating it as a statement about **every**
publication the operator runs silently deletes the independence the whole model is built on. Someone
who complains about the weekly marketing blast is not asking to be cut off from the security-advisory
list they deliberately subscribed to.

The current behaviour was in fact the exact inverse of what was wanted:

| | before | correct |
|---|---|---|
| spam complaint → **global** suppression | yes | **no** |
| spam complaint → unsubscribed from *that* newsletter | **no** | yes |
| hard bounce → global suppression | yes | yes |
| unsubscribe → global suppression | no | no |

A complainer was blocked across every newsletter while remaining `subscribed` to the one they actually
complained about.

Hard bounces are genuinely different, and the distinction is what makes this decision principled rather
than a preference. A hard bounce means **the mailbox does not exist**. That is a fact about the
*address*, not about a relationship — it is equally true for every newsletter, and because all
newsletters share one sending domain and one Postmark server, re-sending to a known-dead address burns
the reputation of *every* publication. So the axis is not "global vs per-newsletter" but:

- **facts about the mailbox** → global (hard bounce, and abuse patterns);
- **facts about the relationship** → per-newsletter (complaint, unsubscribe).

### Why this kept getting re-derived wrong

Worth recording, because it cost several sessions. The decision had been made in conversation but
never written down, while every artifact said the opposite — `ADR-011:51`, `ADR-011:122`, `CLAUDE.md`
twice, and the code itself. `CLAUDE.md` states *"when a rule here and an ADR disagree, the ADR wins"*,
so each fresh reading faithfully rebuilt the old model. **A decision that exists only in conversation
does not exist.** That is the reason this ADR exists at all.

### Bounce as a status, not merely a suppression side effect

A second point, initially missed: `bounced` belongs on the **per-newsletter subscriber record** too,
in addition to the global list. It is a real data point, and filtering `status = bounced` within one
newsletter is far cheaper than joining every subscriber against a global deny-list. The global list and
the subscriber status are **not** redundant — they answer different questions.

## Decision

### 1. Two consequences, never conflated

| signal | global suppression list | per-newsletter status |
|---|---|---|
| **hard bounce** (8 permanent Postmark types) | ✅ yes | ✅ `bounced` |
| **spam complaint** | ❌ **no** | ✅ `complained` |
| **unsubscribe** | ❌ no | ✅ `unsubscribed` |
| **bad actor** (repeat subscribe→complain) | ✅ yes | — *(deferred)* |

The global list remains — it is **in addition to** per-subscriber state, not a replacement for it.

### 2. The subscription lifecycle gains two states

```
pending | subscribed | unsubscribed | bounced | complained
```

Only `subscribed` is sendable, so `resolveRecipients` is unchanged in behaviour.

Transition rules, all idempotent:

- `markBounced` does **not** overwrite `unsubscribed` — someone who opted out and later bounces is
  still, primarily, someone who opted out; that intent outranks a delivery failure.
- `markComplained` overrides everything except itself — it is the strongest per-newsletter signal.
- **`resubscribe()` is legal from `bounced` and `complained`**, not just `unsubscribed`. Mailboxes get
  fixed and people genuinely re-opt-in; and for a hard bounce the *global* list is still the real gate,
  so reviving the row cannot by itself put mail back on the wire.

### 3. The webhook writes to two contexts

`RecordDeliveryEvents` resolves `tag → campaign → { sendId, newsletterId }`, then:

- `SuppressionGateway.suppress(...)` — global, permanent bounces only;
- `SubscriberGateway.record(newsletterId, address, 'bounced' | 'complained')` — per-newsletter.

`SubscriberGateway` is a new consumer-owned port over the `subscriptions` facade along the existing
`campaigns → subscriptions` DAG edge — the *write* direction, complementing `RecipientResolver`'s
reads. It is fulfilled by `MarkSubscriptionOutcome`, which is address-keyed because a webhook payload
carries an address and no subscription id, and **quiet** when no membership exists, because a receiver
that throws makes Postmark retry for hours (ADR-008).

Both writes are driven by the **event**, not by whether a matching row was found: a permanent bounce
for an address we cannot correlate is still permanent.

## Consequences

- **The founding independence rule now actually holds.** A complaint about one newsletter has no effect
  on any other — asserted directly by a test that subscribes one address to two newsletters, complains
  about one, and checks the other is untouched.
- **`ADR-011` is amended.** "The only cross-newsletter fact we track by address is suppression" becomes:
  the only cross-newsletter facts are *mailbox-level* ones — permanent bounces, and later abuse
  patterns. Its bounded-context topology is otherwise unchanged.
- **`spam-complaint` survives in the suppression reason vocabulary** but nothing automatic writes it
  any more. It remains available for a deliberate operator action, and for the deferred bad-actor rule.
- **Two statuses were added to a closed enum**, so the API filter, the OpenAPI schema and the CLI's
  `--status` all had to follow. The CLI change is the second instance of the coupling ADR-016 predicted:
  a contract change carries a client update in the same PR.
- **Complaint handling is now weaker in one respect, deliberately.** A serial complainer stays
  reachable on other newsletters until the bad-actor rule exists. That is the accepted cost of
  independence, and the gap is named rather than hidden.
- **Bad-actor detection is deferred.** Detecting subscribe→complain→resubscribe→complain needs a
  complaint counter keyed by address that outlives the subscription row — a new `deliverability`
  aggregate, not a status flip. It shares that shape with the soft-bounce counter, and the two belong
  together in one ADR.

## Related

- [ADR-011](ADR-011-bounded-contexts.md) — amended: suppression is no longer *the* cross-newsletter fact
- [ADR-008](ADR-008-email-delivery-postmark.md) — the webhook path that now writes to two contexts
- [ADR-015](ADR-015-public-token-unsubscribe.md) — already had this right: unsubscribe ≠ suppression
- [ADR-019](ADR-019-per-recipient-outcome-documents.md) — the send-side record these events also update
