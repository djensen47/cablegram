# ADR-035: Send Outcome and Retry — a send that errors is not a send that failed

## Status

Accepted — 2026-11-16. **Implemented** the same day. Amends
[ADR-008](ADR-008-email-delivery-postmark.md)'s send model — what a send does when the provider call
does not come back cleanly — and changes what the `failed` status means.

## Context

A campaign goes out as **one** `POST /email/bulk` (ADR-008). Two facts about that call decide
everything here:

- **It cannot be made idempotent.** Postmark's Bulk API documents no idempotency key and no
  client-supplied request id. A second submission is a second broadcast.
- **It is all or nothing.** A request with a malformed field is rejected whole with a 422 and "no
  messages in it are processed". So cablegram never holds a half-sent list. What it can hold is a send
  where **it does not know whether Postmark took the request**.

Before this ADR, `SendCampaign` wrapped the provider call and the three writes after it in one `catch`
that marked the campaign `failed`, and a `failed` campaign may be sent again. So every one of these
ended in a campaign that an operator would, reasonably, send again:

1. **Postmark accepted and the answer was lost** — a dropped connection, a timeout, a 5xx. Sending
   again mailed the whole list a second time.
2. **Postmark accepted and a write after it failed** (storing the acknowledgment, raising the
   recipients, marking the campaign `sent`). Same result. This one had already happened in another
   form: the `ID`/`Id` bug (#79) reported every accepted send as a failure.
3. **Two overlapping requests both submitted.** Each read `draft`, and `MongoCampaignRepository.update`
   was an unconditional `replaceOne` by id, so both wrote `sending`. The unit suite could not see it:
   the in-memory repository handed every reader the same object.
4. **A process that died mid-send left `sending` forever.** Nothing moved a campaign out of it, and
   each refused retry inserted a send record and one outcome row per recipient before being refused.

The `Idempotency-Key` header covers none of this. Its store is a per-process `Map` (#62) written after
the handler returns, and the CLI generates a new key on every invocation. More to the point, a key
store answers "did *we* see this request before?" — and the question that matters is about Postmark's
state, which no store on our side holds.

Options considered:

- **A durable idempotency-key store.** Rejected for this purpose, for the reason above. #62 stands on
  its own merits.
- **Split the send into several Bulk calls**, so a duplicate is one chunk rather than the list.
  Rejected: it adds the in-request loop and cursor ADR-008 and ADR-009 exclude, and the chunk in flight
  is exactly as ambiguous as the whole list was. Nothing forces it yet — at about 390 bytes per
  recipient (measured, with unsubscribe headers) one request holds roughly 130,000 recipients under the
  50 MB ceiling.
- **Ask Postmark** (`GET /messages/outbound?tag=<campaignId>`) and decide automatically. Deferred:
  Postmark does not document how soon a submission becomes searchable, so a zero is not proof, and an
  automatic "it did not go" is the one answer that must not be wrong.
- **Fail closed, and let a person say what happened.** Chosen.

## Decision

**`failed` means the send is known not to have gone out. Everything else that is not `sent` stays
`sending`, and nothing sends a `sending` campaign again.** No new status, no new collection, no timer.

1. **A failed provider call says whether a retry is safe.** `EmailRejectedError` — thrown for a **4xx
   only** — means Postmark answered and refused; nothing was accepted. The base `EmailDeliveryError`
   means **unknown**: no answer at all, a 5xx (Postmark's own wording for a 500 is that "in most cases
   the message is lost", which is not a promise), or a 200 the adapter could not read. Unknown is the
   base class on purpose, so a failure nobody classified is treated as the unsafe one. The
   classification lives in the `shared/email` leaf — one place decides what a provider answer means,
   as with `parseProviderEvent` (ADR-021).
2. **Only a refusal makes a campaign `failed`.** `502 send_rejected`, carrying the provider's reason,
   because that is what says what to fix. (A failure *before* anything was submitted — the send record
   could not be opened — also returns the campaign to `failed`: equally known not to have gone out.)
3. **An unknown outcome leaves the campaign `sending`.** `502 send_outcome_unknown` on the request it
   happened to; `409` with the same code on every later `POST /send`. A later request cannot tell a
   send whose answer was lost from one that is still running, so it starts nothing.
4. **Acceptance is final.** Once Postmark returns `Accepted`, nothing marks the campaign `failed`. The
   acknowledgment is stored **first** (`bulkRequestId` on the send record) — it is the proof — then the
   recipients are raised to `accepted`, then the campaign is marked `sent`. If a write fails part-way,
   the campaign stays `sending`, and a repeated `POST /send` that finds the stored acknowledgment
   **finishes the rest without calling the provider**. Every step is repeatable and needs only what is
   on the stored send. The gateway also logs a `bulk_submitted` line with the request id before the
   caller stores anything, so an acknowledgment that never reached the store still exists somewhere.
5. **The claim is a conditional write, made before anything else is stored.**
   `CampaignRepository.saveIfStatus(campaign, from)` puts the status check in the write's own filter,
   so the store decides and exactly one of two racing requests matches — the same shape as
   `applyEvent` (ADR-019), a plain `WHERE id = ? AND status IN (…)` inside ADR-012's portable subset.
   The loser has written nothing. **There is no unconditional `update(campaign)` any more**, and
   editing a campaign uses the same write, so an edit that read `draft` cannot write it back over
   `sending`. `markSent` and `markFailed` are legal from `sending` only.
6. **An operator settles a `sending` campaign**: `POST /v1/campaigns/{id}/send/resolve` with
   `{"outcome": "sent" | "not-sent"}`, or `cablegram campaigns resolve <id> --sent | --not-sent`.
   `sent` completes the campaign; `not-sent` returns it to `failed`. Both responses that report the
   `sending` state say so.
7. **`not-sent` is refused when cablegram knows better** (409), because it is the answer that mails a
   list twice if it is wrong:
   - the send record carries a provider acknowledgment;
   - delivery events have been recorded for the send — nothing else raises a recipient past `pending`
     before the acknowledgment is processed, so any that moved prove a submission;
   - the send started **less than 15 minutes ago**. A `sending` campaign looks the same whether its
     request died or is still waiting on Postmark, and no in-process state can tell them apart
     (ADR-009). Fifteen minutes is longer than a request can run: the provider call is bounded by
     Node's `fetch` timeouts (five minutes for headers, five for the body).

   `sent` needs no wait — a request still running finishes into the same state — and is refused only
   when no send record was ever opened, since the record is written before the provider is called.
8. **The in-memory doubles copy on read and write**, as a driver does. A double that shares one object
   between "stored" and "in use" cannot fail the way the real store does: it hid the overlapping-send
   race, and it counted an acknowledgment as stored when the write that should have stored it threw.

## Consequences

- Running a send again after an error cannot mail the list twice in any of the four cases above. Each
  is a test that breaks the send at that point and calls it again
  (`send-campaign-retry.test.ts`); the race itself is proved against Mongo
  (`mongo-campaign-repository.integration.test.ts`), which is the only place it can be.
- **More sends need a person.** A Postmark outage that used to be "run it again" is now "look at
  Postmark, then resolve". That is the trade: an unnecessary manual check costs minutes, and a second
  copy of an issue in every inbox cannot be taken back.
- **`not-sent` waits 15 minutes** even when the operator is right straight away.
- The operator's answer can still be wrong. The guards catch what cablegram can see; they cannot see
  Postmark. This ADR makes a double send require a deliberate, confirmed, contradicted-by-nothing
  statement — not a retry.
- Accepted gaps, each left alone on purpose:
  - If the write that stores the acknowledgment fails, the campaign is `sending` with no proof and
    must be resolved by hand. The `bulk_submitted` log line is the record.
  - `DELETE` still removes a campaign in any status, including `sending`.
  - The provider call has **no explicit timeout**. Adding one would turn a slow acceptance into an
    unknown outcome; the 15-minute wait is sized to the defaults instead. Change both together.
  - The guard is the status, not a version. Two writers that both hold `sending` are not told apart.
- A list near the 50 MB ceiling will need several Bulk calls. That decision has to extend this one —
  an acknowledgment per chunk — rather than replace it. Asking Postmark automatically can be added on
  top of `resolve` once there is a reliable way to read its answer.

## Related

- [ADR-008](ADR-008-email-delivery-postmark.md) — the one-Bulk-call send model this amends.
- [ADR-009](ADR-009-deployment-digitalocean-functions.md) / [ADR-028](ADR-028-containers-only.md) — no
  in-process state between requests, which is why a running send and a dead one look the same.
- [ADR-012](ADR-012-persistence-mongodb-native-driver.md) — single-document writes, portable subset.
- [ADR-019](ADR-019-per-recipient-outcome-documents.md) — guards in the filter; the outcome rows whose
  status is the delivery evidence in §7.
- #62 — the per-process `Idempotency-Key` store. #79 — the `ID`/`Id` bug.
- Postmark Bulk API: <https://postmarkapp.com/developer/api/bulk-email>
