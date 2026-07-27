# ADR-022: Subscriber Import — Restoring State, Not Creating Consent

## Status

Accepted — 2026-07-27. Implements [#30](https://github.com/djensen47/cablegram/issues/30).

## Context

`cablegram subscriptions import` was not an import. It was a bulk **subscribe**: every CSV row went
through the `Subscribe` use case, which derives its status from a `doubleOptIn` toggle and therefore
can only ever produce `pending` or `subscribed`. `Subscription.create` takes no status at all.

That makes it structurally unable to do the one thing it is needed for — **migrating a list off
another ESP**, where the incoming data already contains people who unsubscribed, hard-bounced, or
filed a spam complaint.

Importing those rows as `subscribed` would mail people who explicitly opted out. That is a compliance
failure (CAN-SPAM / GDPR / CASL), not merely a data-quality one. It would also re-send to known-dead
mailboxes on the very first campaign, burning the sending domain's reputation at exactly the moment
it has no history to absorb the damage. The immediate driver is a pending **~18,000 subscriber**
migration that will be cablegram's first real send.

**The distinction this ADR turns on: an import restores state you already have; a subscribe creates
new consent.** Every rule below follows from it.

The old command had two further problems that only show up at scale. It issued one HTTP POST per row,
sequentially — roughly 15 minutes for 18k rows — with no progress output and no resume, so a failure
at row 12,000 meant re-running the whole file blind. And it had no answer at all for what should
happen when a row already exists.

## Decision

### 1. A separate factory and a separate use case

`Subscription.import({ status, subscribedAt, … })` takes the status **verbatim** and never derives
it; `ImportSubscriptions` is a distinct use case, not a flag on `Subscribe`.

The clearest statement of the difference is what the new use case does *not* have: it takes **no
`DeliveryGateway`**. An import can therefore never send mail — not even for `pending` rows, which
under `Subscribe` would trigger a double-opt-in confirmation. There is no new consent to confirm.

The CSV gains a `status` column accepting the full `SUBSCRIPTION_STATUSES` vocabulary
(`pending | subscribed | unsubscribed | bounced | complained`). Absent or empty falls back to the
batch's `--default-status` (default `subscribed`); an **unknown value fails the row**, exactly as a
malformed address does. Defaulting an unrecognised status would quietly turn someone's opt-out into a
`subscribed`, which is the single worst thing this command could do.

### 2. The original opt-in date is preserved

An optional `subscribedAt` column becomes the subscription's `createdAt`. That timestamp *is* the
consent record — the thing you most need if consent is ever challenged — and letting an import reset
it to "the day we migrated" destroys it silently.

No `source` field was added: every non-reserved column already becomes a merge field with its casing
preserved, so a `source` column works today and is visible to templates.

### 3. An imported hard bounce **does** write the global suppression list

This was the genuinely open question, and it is decided **yes, always** — not behind a flag.

[ADR-018](ADR-018-suppression-scope.md) draws the line by *what kind of fact* a signal is. A hard
bounce says the mailbox does not exist: a fact about the **address**, equally true for every
newsletter, and all newsletters share one sending domain. Second-hand evidence from the previous
provider is still evidence of exactly that, and it is precisely what protects the first send. The
counter-argument — that another ESP's bounce data may be stale — is real but weaker: a resurrected
mailbox costs one manual `suppressions remove`, while a missed one costs sending-domain reputation
that takes months to rebuild.

An imported **`complained` never reaches the global list.** That is settled by ADR-018 and not
re-opened here: a complaint about one publication says nothing about the others.

Suppression is driven by the **file**, not by `--on-conflict`. Skipping a membership row we already
have does not make its mailbox any less dead.

#### The new DAG edge

Doing this in the API (rather than making the CLI issue a second call) means `subscriptions` now
reaches `deliverability`:

```
subscriptions → { newsletters, deliverability }
```

Acyclic — `deliverability` imports no component and remains a leaf. It is a consumer-owned port,
`SuppressionGateway`, fulfilled by a facade adapter, mirroring what `campaigns` already does. The
port exposes exactly one method, `suppressHardBounced`, with the reason **pinned** to `hard-bounce`
in the adapter rather than passed in: leaving the taxonomy open would make it possible to route a
complaint onto the global list — the one thing ADR-018 forbids.

The alternative was to keep the DAG untouched and have the CLI POST bounced addresses to
`/v1/suppressions` itself. Rejected: it would make a compliance-relevant behaviour a property of one
client rather than of the API, so a direct API caller would silently not get it.

### 4. Re-import: `skip` (default) or `overwrite`. **There is no merge.**

```
--on-conflict skip        the existing membership is left untouched (default)
--on-conflict overwrite   the file is the source of truth for it, opt-outs included
```

`skip` makes a re-run a pure resume, which is what a 18k-row migration needs after a failure at row
12,000. `overwrite` is for the case where the file genuinely *is* the truth.

A third "merge" mode was proposed and rejected: file-wins-except-it-cannot-resurrect-an-opt-out. It
sounds safer, and that is the trap. A behaviour that is neither "leave the row alone" nor "the file
is the truth" cannot be described in one sentence, so nobody can predict afterwards what an import
did to their data. **The conservative choice belongs in the default, not in a third blended
behaviour** — which is why `skip` is the default and `overwrite` prompts before running.

An address repeated *within* one batch keeps its first occurrence, matching what a row-at-a-time
import would have produced.

### 5. A bulk endpoint, batched and idempotent

```
POST /v1/newsletters/{newsletterId}/subscriptions/import
{ rows: [...], onConflict?: 'skip' | 'overwrite', defaultStatus?: <status> }
```

Up to **1000 rows per request**; the CLI batches at 500 by default. One batch is one read
(`findByNewsletterAndEmails`, served by the existing `(newsletterId, email)` unique index) and one
bulk write (`saveMany`) — so 18k rows is ~36 requests instead of 18,000, and seconds instead of
quarter-hours.

Both new repository methods are batches of **independent single-document operations** in one round
trip, not transactions: still no replica set required (ADR-012). A partial failure leaving earlier
documents written is exactly what a resumable import wants.

The CLI sends an `Idempotency-Key` per batch, derived from `newsletterId`, the file's basename and
the batch index — so a resumed run reuses the same keys and a lost response replays instead of
re-running. Progress goes to **stderr** per batch, keeping `--json` a clean document; `--dry-run`
prints the full status breakdown and calls no API, which is the operator's last chance to notice an
export that would have re-subscribed everyone.

## Consequences

- **A migration can no longer mail the people who left.** Asserted end-to-end by
  `src/import-then-send.integration.test.ts`: a five-status CSV is parsed by the CLI's own parser,
  imported over HTTP into a real `mongod`, and a campaign is then sent — reaching exactly the one
  `subscribed` address.
- **The `subscriptions → deliverability` edge is new**, and `eslint.config.js` had to be changed to
  allow it. Under [ADR-016](ADR-016-cli-client.md)'s heuristic, needing a boundary-rule change is a
  signal something is wrong — here it is instead the ADR process working as intended: the DAG really
  did gain an edge, and it is recorded rather than smuggled in.
- **`subscriptions import` is a breaking CLI change.** `--no-double-opt-in` is gone (an import sends
  no mail, so the flag was meaningless) and the default status is `subscribed` rather than `pending`.
  Acceptable: cablegram is not yet live and has no production data.
- **`status` and `subscribedAt` are now reserved CSV columns**, so a file that used either as a merge
  field changes meaning. Both are matched case-insensitively, like `email` and `tags`; every other
  header still keeps its exact casing so `{{firstName}}` keeps working.
- **The dry run is now worth running.** It reports the status breakdown and how many addresses would
  be globally suppressed before anything is written.
- **`bulkWrite` enters the persistence vocabulary.** It stays within ADR-012's portable subset — no
  transactions, no Mongo-only operators — but it is a second write shape repositories must implement,
  and the in-memory doubles mirror its semantics (including the unique-key violation).
- **Bad-actor detection is still deferred** (ADR-018), and importing does not change that: an
  imported `complained` is per-newsletter and nothing counts it.
- **What an import cannot do is re-consent someone.** `overwrite` can move a row back to
  `subscribed`, and that is deliberate — but it is an explicit, confirmed operator action against a
  file they supplied, not a default.

## Related

- [ADR-018](ADR-018-suppression-scope.md) — decides §3: mailbox facts are global, relationship facts
  are per-newsletter
- [ADR-011](ADR-011-bounded-contexts.md) — amended: the DAG gains `subscriptions → deliverability`
- [ADR-016](ADR-016-cli-client.md) — the CLI is an HTTP client, so the bulk endpoint had to exist
  first
- [ADR-012](ADR-012-persistence-mongodb-native-driver.md) — the portable subset the batch writes stay
  inside
- [ADR-015](ADR-015-public-token-unsubscribe.md) — the other place unsubscribe ≠ suppression matters
