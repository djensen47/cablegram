# ADR-025: Campaign Test Send — A Proof That Is the Same Send

## Status

Accepted — 2026-07-27. Implements issue #36.

## Context

There was no way to see what a campaign actually looks like before sending it. `campaigns send
<id> --dry-run` reports a **recipient count** and nothing else: it renders nothing and shows nothing.
So the first time a campaign's HTML went through the real render-and-deliver path, and the first time
it reached an inbox, was **the real send** — with a pending ~18,000-subscriber first send behind it.
That is the wrong place to discover a broken template, a mangled layout, or a wrong subject line.

A browser preview does not substitute. Gmail and Outlook rewrite email HTML aggressively — that
hostility is the entire reason MJML exists, and cablegram's authoring workflow (`npx mjml
newsletter.mjml -o newsletter.html`, then `templates create --html`) puts the compiler *outside* the
system, so nothing in cablegram has ever verified the compiled HTML survives the trip. **The only
thing that proves an email works is an email.**

### What makes this dangerous to build

A test send is worth exactly as much as its faithfulness. If it re-implements rendering, renders
against a different model, or takes a different route to the gateway, a green test proves nothing
about the real send and is **worse than useless** — it manufactures confidence. So the design
constraint is not "a preview endpoint" but "the same send, aimed elsewhere, recording nothing".

The second constraint is the opposite of the first: a test send must be safe to run twenty times
while iterating on a template. A proof that moves the campaign's stats, opens a `Send`, writes
recipient outcomes, or advances the status is not repeatable and is not a proof — it is a send.

Those two pull against each other on five specific questions, each of which changes behaviour. They
were decided rather than assumed.

## Decision

`POST /v1/campaigns/{id}/test` with a small list of addresses, plus
`cablegram campaigns test <id> --to me@example.com` (repeatable).

### 1. It renders and delivers through the send path's own code

`SendTestCampaign` calls `MessageRenderer.render(campaign.contentRef(), {})` — the *same* method,
the same content ref, the same empty model (a campaign is one Bulk call with a shared body,
[ADR-008](ADR-008-email-delivery-postmark.md), so the real send renders once against `{}` too). It
builds `List-Unsubscribe` headers with the same `unsubscribeHeaders(...)` function, which was
extracted from `SendCampaign` for this and is now shared by both. It hands the result to the same
`DeliveryGateway`.

**This is asserted by a test, not by inspection.** The renderer is wrapped in a recorder, both paths
are run, and their captured arguments are compared. A future change that gives the test send its own
rendering call fails that test.

The consequence: **a campaign with unusable content fails a test send exactly as it fails a real
one** (`CampaignContentError`), which is most of the value.

### 2. It writes nothing, and does not read the list

No `Send`, no `RecipientOutcome`, no stats movement, no `markSending`/`markSent`, no `sendId` — the
campaign is read and never written. `resolveRecipients` is **never called**: the addresses given ARE
the recipient set. That, too, is asserted by rebinding the resolver to one that throws if touched.

The response DTO is the entire record of a test send; there is no resource to read back.

### 3. The global suppression list still applies

A test send filters its addresses through `SuppressionGateway.filterSuppressed` and reports what it
dropped. The list exists to stop cablegram mailing dead mailboxes, and an operator-triggered path is
not an exception to that: the one code path that could silently mail a suppressed address should not
be the one run twenty times in a row. If you need to prove delivery to an address that legitimately
bounced once, `cablegram suppressions delete <address>` is one deliberate command — which is the
right amount of friction for "mail this known-bad mailbox anyway".

Note the asymmetry with a real send, and that it is intentional: **gate 1 (subscribed) is skipped,
gate 2 (suppressed) is kept.** Gate 1 answers "who wants this?", which a test send answers by
argument. Gate 2 answers "which mailboxes must we not touch?", which nothing overrides.

### 4. Category is `broadcast`

Same message stream, same Postmark server token, same reputation path as the real thing. A
`transactional` test send would keep proof traffic off the broadcast stream's stats — but it would no
longer be the same send, and stream-level differences in rendering or filtering are exactly what this
is meant to catch. Faithfulness wins.

### 5. The `List-Unsubscribe` header is included, bound to a synthetic subscription id

A test address usually has no subscription, so there is no real `subscriptionId` to bind the
HMAC to ([ADR-015](ADR-015-public-token-unsubscribe.md)). Three options: omit the header, look up a
real subscription, or mint one against a fresh id. **A fresh synthetic id wins**, because it is the
only option that is both faithful and inert:

- the token **verifies**, so the mail client renders the unsubscribe affordance and the operator can
  actually see it — mail without one is treated differently by inbox providers, so omitting it would
  make the proof unfaithful in a way that matters;
- the one-click `POST` lands on `PublicUnsubscribe`'s valid-token/no-matching-row path, which is a
  **quiet success** by existing design — so proof-mailing yourself cannot unsubscribe you from your
  own newsletter.

Looking up a real subscription was rejected: it would make a test send read the subscriber list
(violating §2) and make the header's presence depend on invisible state.

### 6. The subject is prefixed `[TEST] ` by default, and `prefixSubject: false` removes it

Default on, so a proof landing in a shared inbox is never mistaken for the real issue. But the
subject line is the thing most likely to be wrong, and inbox-list truncation is a real thing to
check — so `--no-prefix` (`prefixSubject: false` on the wire) sends it byte-identical to what
subscribers will receive. The convenience is the default; the byte-identical proof is one flag away.

### 7. Legal in any status, including `sent`

Nothing is recorded, so nothing can be corrupted, and "what did we actually send?" is a real question
with no other answer. A `draft` campaign is unchanged, a `sent` one stays sent with its stats intact.

### 8. The provider tag is `test:<campaignId>`, never the bare campaign id

A real send tags with the bare campaign id so webhooks correlate to it. A test send must not: an open
or a bounce on the proof would otherwise be applied to the campaign's real recipient outcomes — the
one way a "records nothing" feature could still leave a trace, and it bites hardest on a `sent`
campaign that has outcomes to corrupt. `test:<id>` is deliberately not a campaign id, so
`RecordDeliveryEvents` looks it up, finds nothing, and skips the event — while the tag still names
the campaign in Postmark's own activity view. It does not become an unhandled event: unrecognized
*tags* are tolerated, and only unrecognized *record types* are recorded
([ADR-021](ADR-021-unhandled-webhook-events.md)).

### 9. Five addresses, de-duplicated

Enough for the operator plus a couple of inbox-rendering accounts, small enough that this can never
become a side door onto the list. The cap lives on the use case (`MAX_TEST_RECIPIENTS`) and the zod
schema imports it, so the edge cannot drift from the invariant. Addresses are normalized through the
shared `normalizeEmailAddress` (so `Me@Example.COM` matches its own suppression entry) and
de-duplicated, so a repeat is mailed once and cannot pad the cap. The CLI mirrors the number by hand,
as it mirrors every other DTO ([ADR-016](ADR-016-cli-client.md)).

## Consequences

- **The last safety net before the ~18k send exists**, and it exercises the compiled MJML through the
  real path rather than a browser's forgiving renderer.
- **`unsubscribeHeaders` moved out of `SendCampaign`** into `application/unsubscribe-headers.ts`, now
  shared. That is the point — a second implementation would be a second thing to keep faithful — but
  it means the header logic is no longer local to the send it was written for.
- **A test send costs real Postmark reputation on the broadcast stream.** Accepted: five addresses,
  and a proof that used a different stream would not be a proof.
- **`--dry-run` still exists and still only counts.** The two answer different questions ("how many?"
  vs "what does it look like?") and neither replaces the other.
- **The faithfulness is enforced by exactly two tests** — the shared-render assertion and the
  forbidden-resolver assertion. If either is deleted, the feature can silently rot back into a
  lookalike. They are the load-bearing tests in the file.
- **Still not faithful in one respect**, and knowingly: the recipient's `List-Unsubscribe` token
  points at a subscription that does not exist. Everything a mail client can observe is identical;
  only acting on it differs.
- **`customFields` are still not rendered** ([ADR-024](ADR-024-custom-fields.md) §2) — so a test send
  faithfully reproduces `Hi {{firstName}}` sending "Hi " to everyone. That is a real defect the test
  send now makes *visible* rather than fixing, which is the correct division: rendering is an ADR-008
  change.

## Related

- [ADR-008](ADR-008-email-delivery-postmark.md) — the send path this mirrors (one Bulk call, shared body)
- [ADR-015](ADR-015-public-token-unsubscribe.md) — the per-recipient `List-Unsubscribe` header, and
  the quiet-success path that makes a synthetic token safe
- [ADR-018](ADR-018-suppression-scope.md) — what the global suppression list is *for*, which decided §3
- [ADR-019](ADR-019-per-recipient-outcome-documents.md) — the outcome documents §2 refuses to write
- [ADR-024](ADR-024-custom-fields.md) — the unrendered custom fields a test send now exposes
- Issue [#36](https://github.com/djensen47/cablegram/issues/36)
