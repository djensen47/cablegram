# ADR-019: Per-Recipient Outcome Documents (splitting the send record)

## Status

Accepted — 2026-07-27. Amends [ADR-008](ADR-008-email-delivery-postmark.md)'s send-record shape.
Addended 2026-07-27 (§6): the `rejected` outcome status is removed for the same reason `errorCode`
was.

> ADR-018 is intentionally unused — it is reserved for the in-flight
> per-newsletter suppression scoping work, which was branched first but will land after this.

## Context

`SendRecord` was one document per campaign send, holding two unbounded arrays: `outcomes` (one entry
per recipient) and `appliedEvents` (one entry per webhook applied, across every recipient). Every
webhook loaded that document, mutated an array, and wrote the whole thing back with `replaceOne`.

That shape is fine at demo scale and fails at the first real send. With an 18,000-subscriber list:

| | measured |
|---|---|
| document size | **5.2 MB** (2.8 MB outcomes + 2.4 MB dedupe keys) |
| at 50k recipients | 14.4 MB — near the ceiling |
| at 100k recipients | **28.7 MB — exceeds MongoDB's 16 MB BSON limit** |
| webhooks per send | ~50,000 (one POST per event, per recipient — verified against Postmark's docs) |
| I/O per send | ~50,000 × (5.2 MB read + 5.2 MB write) ≈ **560 GB** |
| dedupe cost | `appliedEvents.includes()` is a linear scan → ~1.5 billion string comparisons |

Four failure modes, worst first:

1. **Silent lost updates.** The write was `replaceOne({_id}, wholeDocument)` with no version field and
   no conditional guard. Postmark delivers webhooks concurrently, so two events arriving together each
   read the document, applied their own change, and wrote back a document built from a stale read —
   the second erasing the first. At 50k events against one document this loses a large fraction of
   outcomes, and reports nothing. Stats simply come out wrong.
2. **A hard ceiling at ~100k recipients**, where writes begin erroring mid-campaign and every
   subsequent event for that send is permanently lost.
3. **I/O amplification** — 560 GB for one campaign, and a full 5 MB deserialize on every serverless
   invocation.
4. **O(n²) dedupe**, on top of that deserialize.

It also violated [ADR-012](ADR-012-persistence-mongodb-native-driver.md)'s own rule — *"id-reference
relations only, no embedded documents"*. The repository carved out an exception ("an aggregate-internal
projection, not a relation"), and that rationalization is exactly what broke.

Two related defects surfaced while reading the code, both fixed here because they live in the same
webhook path:

- **`opens`/`clicks` could never exceed 1.** The dedupe key was `<messageId>:<type>`, so the second
  `Open` webhook for a message was discarded. Postmark POSTs one webhook *per open*. The field was
  typed and named as a counter and behaved as a boolean.
- **Seven permanent bounce types were silently discarded.** `parseProviderEvent` matched the literal
  string `HardBounce` and dropped everything else — including `BadEmailAddress`, `Blocked` and
  `DMARCPolicy`, which Postmark classifies as permanent and has already deactivated. Those addresses
  were never suppressed and were re-sent on every subsequent campaign.

## Decision

### 1. Split the aggregate

```
campaign_sends                  one small doc per send — submission facts only
  { _id, campaignId, bulkRequestId, submittedAt, recipientCount, … }

campaign_recipient_outcomes     one doc per recipient
  { _id, sendId, campaignId, address, messageId,
    status, statusPriority, opens, clicks, applied[], … }
  unique (sendId, address) · (sendId, status) · (sendId, _id)
```

`campaign_sends` is written exactly twice — opened before the provider call, stamped on
acknowledgement — and never by a webhook, so `replaceOne` is safe there.

The old name `send_records` described neither its contents nor its scope; renamed while the data is
being rewritten anyway. Nothing is deployed, so there is no migration.

### 2. Webhooks perform one atomic single-document update

```js
updateOne(
  { sendId, address, applied: { $ne: key }, statusPriority: { $lt: 4 } },
  { $set: { status: 'bounced', statusPriority: 4 }, $addToSet: { applied: key } },
)
```

Both guards live in the **filter**, so the store evaluates them and the application never reads first:

- `applied: { $ne: key }` — a replayed webhook is a no-op. Postmark retries for hours on any non-200,
  so duplicates are routine, not exceptional.
- `statusPriority: { $lt: n }` — status only ever *raises*. A `delivered` arriving after a `bounced`
  matches nothing, so out-of-order delivery converges instead of flapping.

A plain conditional update rather than `$max` or an aggregation-pipeline update: `WHERE priority < n`
is expressible in any store, which keeps ADR-012's portable subset intact rather than carving a
second exception immediately after closing the first. Single-document atomicity is the only guarantee
required — consistent with ADR-012's "every write is a single document, nothing uses transactions".

The domain expresses *intent* (`effectOf(event) → raise | count | ignore`) and the repository turns it
into that update. The aggregate deliberately **cannot** mutate itself in memory and be saved back:
that pattern is what lost updates.

### 3. Stats are counted on read, not maintained on write

`campaign.stats` was recomputed and rewritten on every webhook — 50k campaign writes per send. It is
gone (see §7); the campaign keeps a plain `recipientCount`, and live delivery counts come from a
grouped count over the outcomes when the send is read.

Counters were rejected: incrementing correctly requires knowing the *previous* status
(pending→delivered is −1/+1). The previous status **is** obtainable atomically — `findOneAndUpdate`
with `returnDocument: 'before'` returns the pre-image — so the first version of this section
overstated it as "not derivable from a single atomic update." The real objections are the two that
survive: applying the ∓1 is a **second write to a second document**, which ADR-012 has no transaction
to pair with the first, and every one of ~50k webhooks would contend on the same campaign document.

**Visible consequence:** a campaign *list* shows `recipientCount` only, while reading a campaign's
send shows live delivery counts. This is the trade accepted in exchange for removing 50k writes per
send.

### 4. Recipients are a paginated resource, not an inline array

`GET /v1/campaigns/{id}/send` returns the send + live stats and **no recipients** — inlining 18k rows
is the same unbounded-collection problem moved to the wire. They are
`GET /v1/campaigns/{id}/send/recipients`, cursor-paginated, filterable by `status` or `failuresOnly`.

The CLI's `campaigns report` follows, gaining `--all`, `--limit`, `--cursor` and `--summary`.

### 5. Fixed in passing

- **Opens/clicks are totals.** The dedupe key for repeatable events includes the event timestamp
  (`<messageId>:open:<occurredAt>`), so genuine repeat opens count while a retry of the same event —
  which carries the same timestamp — is discarded. Postmark's `FirstOpen` flag is normalized through
  as `firstEngagement` so "unique" remains derivable. Unique opens are also simply
  `count(outcomes where opens > 0)`.
- **Bounce classification is by permanence**, against Postmark's published type table:
  `HardBounce`, `BadEmailAddress`, `Blocked`, `DMARCPolicy`, `SpamNotification`, `AddressChange`,
  `Unconfirmed`, `ManuallyDeactivated` all suppress. Transient types (`Transient`, `SoftBounce`,
  `DnsError`, `AutoResponder`, …) are still dropped — a full mailbox is not a reason to stop mailing
  someone. Detecting a *pattern* of soft bounces needs a counter and is deferred.
- **`errorCode` removed.** Nothing ever wrote it; it was a permanent `0` exposed through the API and
  the CLI. Wiring it from Postmark's bulk response is a separate change.

### 6. Addendum (2026-07-27): the `rejected` outcome status is removed too

The same defect as `errorCode`, missed on the first pass: `rejected` was in `OUTCOME_STATUSES`,
counted in `CampaignStats`, on the wire in `StatsSchema`, in the CLI report, and in the
`failuresOnly` filter set — and **nothing could ever write it.**

Checked against Postmark's live docs rather than restated from memory, and there is no source to
wire it to:

- `POST /email/bulk` is asynchronous. The response is `{ID, Status, SubmittedAt}` — a submission
  ack with no per-message results and no `ErrorCode`. (`POST /email/batch` *does* return per-message
  error codes, but that is the synchronous endpoint this system deliberately does not use, ADR-008.)
- A request the provider will not take at all comes back 422 and throws, which fails the whole
  **campaign** (`status: failed`). That is not a per-recipient fact and never was.
- The only genuinely send-time bounce types — `SMTPApiError` (100007) and `TemplateRenderingFailed`
  (100010) — arrive later as *webhooks*, and both are classified transient (ADR-020). Re-badging
  them `rejected` was considered and rejected: they describe **our** template or API being wrong,
  not the address, so folding them in beside bounces and complaints under `failuresOnly` would
  conflate an operator bug with a bad recipient.

There was also a structural tell. `rejected` sat at `STATUS_PRIORITY: 0`, *below* the `pending` (1)
that every outcome is created at, and `applyEvent` raises only on `statusPriority < n` — so the
status was unreachable through the sole write path even for code that tried. It is not merely
unwritten; it is unwritable.

Removed from the domain enum, `CampaignStats`/`zeroStats`, `StatsSchema`, the `failuresOnly` set and
the CLI. Both repositories' `accepted` derivation loses its subtrahend and becomes
`recipients − pending`. This is a **breaking change** to `CampaignStats` — a field disappears from
`GET /v1/campaigns/{id}/send` — taken now precisely because nothing is deployed and no first send has
run. Priorities are left numbered from 1, leaving the slot below `pending` free should a real
pre-acceptance failure ever have a source.

### 7. Addendum (2026-07-28): the stored `campaign.stats` snapshot is removed too

§6 applied the permanently-zero argument to one field and stopped. The object holding it had the same
defect, four times over.

`campaign.stats` was written exactly once, by `markSent`, from a count taken moments after
`markAccepted` had raised every recipient. So the stored value could only ever be:

```
{ recipients: N, accepted: N, delivered: 0, softBounced: 0, bounced: 0, complained: 0 }
```

`recipients` and `accepted` are necessarily equal and both equal `Send.recipientCount`. The other four
are fed exclusively by webhooks arriving *after* the only write, and §3 is precisely the decision never
to rewrite the campaign again — so nothing could raise them. `cablegram campaigns get` printed four
hardcoded zeros to the operator.

The field survived §3 as **residue**: it made sense when it was maintained on write, and removing the
writes left it behind rather than prompting the question of whether it should still exist.

Replaced by `recipientCount: number` on the campaign — one fact, written once at submit, which is all
the list column ever needed. `CampaignStats` remains as the counted-on-read shape behind
`GET /v1/campaigns/{id}/send`; it is now *only* that, and is never persisted. `applyStats()` is
deleted (zero callers — it existed to re-stamp a snapshot there is no longer any reason to re-stamp).

Breaking on the wire (`stats: {...}` → `recipientCount: number`) with no deprecation window, on the
same grounds as §6 and ADR-024's rename: nothing is deployed and there are no consumers.

## Consequences

- **A webhook costs 1 read + 1 write**, both single-document, instead of a 5 MB read-modify-write plus
  a campaign rewrite. No lost updates, no BSON ceiling, no O(n²) scan.
- **The unit suite cannot prove the important part.** Atomicity under concurrency is invisible to a
  single-threaded in-memory double, so the guarantees are pinned by integration tests against a real
  `mongod` — including 20 concurrent opens on one recipient and concurrent events across recipients.
  The in-memory double mirrors the *semantics* (dedupe, only-raise, "false when nothing changed"), not
  just the signatures, so it cannot pass where the real store would fail.
- **A campaign carries no delivery counts at all** — only `recipientCount`. Delivery numbers require
  reading the send (§3, §7). The most likely thing to be surprising.
- **Two API reads where there was one** for a full report. The CLI hides this behind one command.
- **Outcome rows are never cleaned up.** 18k rows per send accumulate indefinitely. Not addressed
  here; a retention policy will eventually be needed, and `recipientCount` is stored on the send
  precisely so the denominator survives archiving the rows.
- **Soft-bounce and bad-actor counters get a natural home** — per-recipient documents already exist to
  hang them on. Both are still deferred.

## Related

- [ADR-008](ADR-008-email-delivery-postmark.md) — the send/webhook flow whose record shape this changes
- [ADR-012](ADR-012-persistence-mongodb-native-driver.md) — the portable-subset + single-document-write
  rules this restores compliance with
- [ADR-017](ADR-017-component-owned-collections.md) — where the new collections and indexes are declared
