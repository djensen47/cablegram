# ADR-032: Newsletter Opt-In Mode — set once per newsletter, single opt-in by default

## Status

Accepted — 2026-11-12. **Implemented** the same day.

## Context

Whether a signup must be confirmed by email was decided **per request**: `doubleOptIn` on
`POST /v1/newsletters/{id}/subscriptions` (and `--no-double-opt-in` on `cablegram subscriptions add`),
defaulting to `true`. Two things were wrong with that.

- **The choice lived in every caller.** A signup form, a script and the CLI each had to repeat it on
  every request, and nothing stopped two of them disagreeing about the same newsletter. The schema
  already described the flag as a "per-newsletter opt-in toggle", which it never was.
- **The default picked the one mode that cannot work yet.** The confirmation email carries an API path,
  not a usable link, and since ADR-031 a newsletter with no `confirmationChannel` refuses double opt-in
  signups outright. Leaving the flag out therefore meant a refused signup.

## Decision

1. **`Newsletter.doubleOptIn`**, a boolean set on create and changeable on `PATCH`
   (`cablegram newsletters create|update --double-opt-in / --no-double-opt-in`).
2. **It defaults to `false` — single opt-in** — on create, and for a newsletter stored before the field
   existed (read as `false`; no migration).
3. **A signup follows the newsletter unless it says otherwise.** The request's `doubleOptIn` is kept as
   an override in both directions; omitted, the newsletter's setting decides. `cablegram subscriptions
   add` gains `--double-opt-in` alongside `--no-double-opt-in`, and with neither it sends nothing.

The ADR-031 guard is unchanged: a signup that resolves to double opt-in on a newsletter with no
`confirmationChannel` is still refused (409) before anything is written. Import is unaffected — it
never sends mail and takes each row's status from the file (ADR-022).

## Consequences

- One decision per newsletter, visible in `newsletters list`, instead of one per request.
- **Behavior change:** a signup that omits `doubleOptIn` used to be double opt-in and is now single
  opt-in unless the newsletter is set otherwise. A caller that relied on the old default must pass
  `doubleOptIn: true` or set it on the newsletter. Released as a minor version (3.3.0), as with ADR-030
  and ADR-031: there are no other consumers.
- A default of single opt-in means a signup form that never thinks about consent subscribes people
  unconfirmed. That is accepted because double opt-in does not work end to end yet; once it does, a
  newsletter that wants confirmation is one `PATCH` away.
- Two places can still choose (newsletter and request). The request override was kept rather than
  removed, so callers that pass it today are unaffected.

## Related

- [ADR-022](ADR-022-subscriber-import.md) — import restores status and sends no mail; unaffected.
- [ADR-023](ADR-023-consent-record.md) — the consent record a confirmation adds to.
- [ADR-031](ADR-031-confirmation-and-system-channels.md) — the confirmation channel a double opt-in
  signup needs.
