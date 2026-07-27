# ADR-021: Unhandled Webhook Events — recording what the receiver cannot act on

## Status

Accepted — 2026-07-27. Extends [ADR-008](ADR-008-email-delivery-postmark.md).

## Context

The Postmark receiver must always answer `200`. A non-200 makes Postmark retry the same event for
hours, so every failure mode in the webhook path is deliberately tolerant: an unknown campaign, an
untagged event and a missing recipient row are all skipped rather than raised (ADR-008, ADR-018).

Tolerance had quietly become erasure. `parseProviderEvent` returned nothing for any `RecordType` it
did not handle and for any malformed body — no event, no stored state, and **no log line anywhere in
the path**. If Postmark added a record type, renamed one, or started sending something we assumed we
handled, those events were lost permanently and there was no way to find out. The failure was silent
*and* undetectable, which is worse than either alone: the system looks healthy precisely because the
evidence is gone.

This is the same shape as the bug ADR-020 fixed — transient bounces were discarded so completely that
a subscriber who soft-bounced twenty times was byte-identical to one who received all twenty — and the
same shape as the seven permanent bounce types ADR-019 found being dropped because the code matched
only the literal `HardBounce`. Both were found by reading the code, not by an alert. That is twice
that "the parser silently returns nothing" has hidden a real defect, which is enough to treat the
silence itself as the problem rather than fixing each instance.

"Always succeed" does not have to mean "never notice."

### Why not a log line

The obvious fix is one line of logging on the drop path. It was rejected.

cablegram runs on DigitalOcean Functions (ADR-009), where activation logs are hard to search,
impossible to aggregate, and cannot be alerted on. A log line there is written and never read — a
diary, not observability. Worse, it cannot answer the question anyone would actually ask: *is Postmark
sending us anything we're dropping?* Answering that from logs requires already suspecting the answer
and knowing roughly when to look, which is the same position we were in with no logging at all.

The question is about accumulated state across invocations, so the answer has to be state. It also
has to be state cheap enough to write on a path that runs ~50,000 times per send.

## Decision

Unrecognized provider payloads are recorded in the database as **queryable state**, keyed by the kind
of event, and read back through the API and CLI.

### 1. The parser reports what it could not claim

`parseProviderEvent` returns `{ events, unhandled }` rather than a bare `DeliveryEvent[]`. What it
could not normalize comes back alongside what it could, as a bucket key plus a truncated sample.

The alternative was to have `RecordDeliveryEvents` re-inspect the raw payload for anything the parser
did not claim. That was rejected: it would put "what does cablegram handle" in two places, and they
would drift — the second copy is only ever updated by someone who remembers it exists. `shared/email`
already owns that knowledge, so it should be the one to state the negative case too.

The parser stays a pure `shared/*` leaf (ADR-005): it *classifies*, and writes nothing. The write
belongs to `campaigns`, which owns a repository. This is the same split as everywhere else — a leaf
may not reach into storage, so it returns a fact and lets a component persist it.

### 2. One document per *kind* of event, never one per event

Storage is a single upsert keyed on the bucket:

```ts
updateOne(
  { _id: key },
  { $inc: { count: 1 },
    $set: { lastSeenAt: now },
    $setOnInsert: { sample, firstSeenAt: now } },
  { upsert: true },
)
```

This is the load-bearing choice. One row per *event* would reintroduce exactly what ADR-019 removed —
a collection that grows with traffic, needing a TTL, a retention policy and a pagination story — in
order to record a fact whose whole value is "this keeps happening." Keyed by kind it is bounded by
Postmark's record-type table: a handful of rows, forever, at any volume.

It is also a **single-document atomic write** (ADR-012), so concurrent webhooks for one key sum rather
than overwrite, and no transaction is needed. There is deliberately no read-modify-write here, for the
reason ADR-019 spells out at length.

`$setOnInsert` pins `sample` to the **first** payload seen, not the latest, so a row means the same
thing when someone looks at it a week later. The sample is truncated (1000 chars) and the key is
bounded (100 chars): enough to see the shape, not enough to become a copy of the traffic.

### 3. The buckets

| key | when |
|---|---|
| `<RecordType>` | a record type cablegram does not handle |
| `Bounce:<Type>` | a bounce type in neither the permanent nor transient table |
| `<RecordType>:__no-address` | a handled type whose payload carried no address |
| `__unparseable` | a non-object body, or one with no usable `RecordType` |

`Bounce:<Type>` is the bucket worth having. Both bounce tables are pinned to Postmark's published type
list, so an entry appearing here means that list moved and we are discarding real failures under a
name nobody has seen — precisely the ADR-019 bug, caught automatically the next time it happens.

`<RecordType>:__no-address` exists because "we handle `Delivery`" and "we applied this `Delivery`" are
different claims, and the gap between them is what goes unnoticed.

### 4. Deliberate drops are not surprises

`AutoResponder` and `Subscribe` are on an explicit ignore list and create no rows. Neither is a
delivery failure — an out-of-office reply means the mail arrived (ADR-020), and a subscription notice
is not about deliverability at all.

The distinction is the point: a report that mixes "we don't understand this" with "working as
designed" is one people stop reading, and a report nobody reads is the logging outcome again.

### 5. Read-side

`GET /v1/webhooks/unhandled` (Bearer JWT, ADR-013) and `cablegram webhooks unhandled` (ADR-016).
Unpaginated, because §2 makes the collection bounded by the record-type table rather than by traffic —
a page would only ever be a page of everything.

Note the asymmetry: the *receiver* sits outside `/v1` with HTTP Basic auth because Postmark calls it,
while its operator-facing read side is an ordinary JWT route. Two audiences, two credentials, one
component.

## Consequences

- **A whole class of silent failure becomes visible.** A non-empty list is a standing signal that
  Postmark is sending traffic cablegram discards — the question that previously required reading the
  parser to even ask.
- **One extra write, only when something is unrecognized.** The healthy path is unchanged: a
  `Delivery`, `Bounce`, `Open` or `Click` writes nothing here. Cost is proportional to surprise.
- **The report needs a human to look at it.** This is state, not an alarm; nothing pages anyone. That
  is a deliberate floor rather than a ceiling — it makes the data exist, which is the precondition for
  alerting on it later, and it is the most that stateless, ephemeral functions (ADR-009) support
  without new infrastructure.
- **Counts are all-time and cannot be reset through the API.** The trade for the bound in §2: there is
  no per-day breakdown and no "clear this now that it's fixed" — the row's `lastSeenAt` is how you tell
  a fixed problem from a live one. A `DELETE` could be added if that proves annoying; it was left out
  rather than guessed at.
- **A very high-cardinality `RecordType` would grow the collection.** Only Postmark can write here (the
  receiver is authenticated), the key is length-bounded, and record types are a closed vocabulary in
  practice — so this is noted, not defended against.
- **`parseProviderEvent`'s signature changed**, which is a breaking change for every caller. There is
  one, plus tests. Returning a bare array again would restore the silence.

## Related

- [ADR-008](ADR-008-email-delivery-postmark.md) — the webhook path and the always-200 rule this works within
- [ADR-019](ADR-019-per-recipient-outcome-documents.md) — the per-document, atomic-upsert discipline §2 follows, and the dropped-bounce-types bug §3 guards against
- [ADR-020](ADR-020-soft-bounce-streak.md) — the previous "silently discarded events" fix, and the source of the ignore list
- [ADR-017](ADR-017-component-owned-collections.md) — `campaign_unhandled_events` is declared by `campaigns`, registered in `src/indexes.ts` with no indexes (the key is the `_id`)
- [ADR-009](ADR-009-deployment-digitalocean-functions.md) — the logging constraint that makes this state rather than a log line
- [Issue #29](https://github.com/djensen47/cablegram/issues/29) — the original write-up
