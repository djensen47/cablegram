# ADR-024: Custom Fields — Naming the Bag, and Naming What Is Still Undecided

## Status

Accepted — 2026-07-27. Renames `mergeFields` → `customFields`. Records — but does **not** settle —
the two open questions about what the field is.

## Context

`mergeFields` was the only part of the schema no ADR had ever decided. It arrived as a Prisma `Json`
column, survived the native-driver rewrite ([ADR-012](ADR-012-persistence-mongodb-native-driver.md))
unexamined, and has been carried forward on inertia ever since. It was noticed while adding `source`
([ADR-022](ADR-022-subscriber-import.md) §4) and the consent record
([ADR-023](ADR-023-consent-record.md)), both of which had to define themselves *against* it — "this is
metadata, not a merge field" — using a term nothing had defined.

### The name

`mergeFields` is mail-merge terminology, borrowed from MailChimp, and for a MailChimp-shaped product
that is defensible ubiquitous language. But it names the **mechanism** (a merge, at render time)
rather than the **data** (things the subscriber told you about themselves). `customFields` names the
latter, and the difference is not cosmetic: the distinction this bag needs to hold against is the one
ADR-022 and ADR-023 kept drawing by hand — that `source`, `signupIp` and `confirmedAt` are facts
cablegram observed about the *record*, with a fixed vocabulary, that must never be renderable, while
anything in this bag is subscriber-supplied and may be. "Custom" says whose data it is; "merge" says
what happens to it later.

The rename is also cheap **now** and not later: `customFields` is on the wire, so once there are API
consumers it becomes a breaking change with a deprecation window. cablegram is not live and has no
production data.

### What this ADR deliberately does not decide

Two real problems were found alongside the name. Both are recorded here so they stop being invisible,
and both are deferred rather than resolved, because resolving either changes behaviour and this change
does not:

**1. It is untyped and open, where everything else is closed.** Edge validation is
`z.record(z.unknown())` — a schema that accepts anything. Meanwhile `SUBSCRIPTION_STATUSES`,
`SUPPRESSION_REASONS` and `OUTCOME_STATUSES` are all closed sets, each carrying the same stated
reason: *"a closed set, not a free-text field, so every caller and every list filter agrees on the
vocabulary."* This is the exact inverse. It is also an unverified contract between two components —
`templates` renders `{{firstName}}`, `subscriptions` stores whatever a CSV header happened to say, and
nothing checks they agree, so a typo in a spreadsheet header is invisible until it ships in mail.

**2. Nothing renders it.** `resolveRecipients` projects per-recipient `customFields`, and they survive
all the way to `campaigns`' `RecipientResolver` — then `send-campaign.ts` renders **once, against an
empty model**, because a campaign is one Bulk call with a shared body
([ADR-008](ADR-008-email-delivery-postmark.md)). The projected values are never read. A template
saying `Hi {{firstName}}` currently sends "Hi " to everyone, and the `email` port has no per-recipient
content field at all — `EmailRecipient` carries only `email` and `headers`.

These two are entangled, and the order matters: **typing the bag is theoretical until personalization
actually renders.** If bodies stay shared, `customFields` is inert storage and a schema for it
constrains nothing. If they do not stay shared, that is an ADR-008 change, and the vocabulary question
belongs inside that decision rather than ahead of it.

## Decision

### 1. `mergeFields` → `customFields`, everywhere at once

Domain type (`CustomFields`), the aggregate property, the stored Mongo field, the wire DTO, the
subscribe and import request bodies, and the CLI DTO. `RecipientProjection.mergeModel` becomes
`customFields` too, so one name spans the whole path from CSV column to send-path projection.

Done as a single mechanical rename rather than an alias-plus-deprecation, because the only reason to
carry both names is existing consumers, and there are none.

### 2. The CSV surface does not change

A custom field has never been named in a CSV — it is *every column that is not reserved*. So the file
format is untouched by the rename. The reserved list (`email`, `tags`, `status`, `subscribedAt`,
`source`, and the six consent-evidence columns) is what separates metadata from custom fields, and
ADR-022/023 already established that anything metadata-shaped gets reserved precisely so it does not
fall into this bag.

### 3. The two open questions are recorded, not answered

Written into the `CustomFields` doc comment and into this ADR so the next reader finds them at the
type rather than rediscovering them. Neither is scheduled.

## Consequences

- **`customFields` is the stored Mongo field name now.** Any document written under the old name would
  read back as an empty bag. There is no migration and none is needed: nothing is live, and the ~18k
  import has not run yet. **If that stops being true, this becomes a data migration** — which is the
  reason to do the rename before the import, not after.
- **A breaking API change**, taken deliberately while it costs nothing.
- **`mergeFields` still appears in ADR-007 and ADR-012**, which are historical records of decisions
  made at the time. They are left as written; ADR-012's line already lists `outcomes`, a field ADR-019
  removed, and the convention here is that ADRs record what was decided rather than get retro-edited.
  ADR-022 and ADR-023 *were* updated, since they describe current behaviour and are a day old.
- **The two real problems are still real.** This ADR improves the name and the documentation and fixes
  nothing about the type or the rendering. That is the point — a rename that quietly shipped a
  behaviour change would be worse — but it should not be mistaken for having addressed them.

## Related

- [ADR-022](ADR-022-subscriber-import.md) — `source`: metadata is not a custom field
- [ADR-023](ADR-023-consent-record.md) — consent evidence, reserved for the same reason
- [ADR-008](ADR-008-email-delivery-postmark.md) — the shared-body send that makes rendering moot today
- [ADR-012](ADR-012-persistence-mongodb-native-driver.md) — where the `Json` column came from
