# ADR-014: Passwordless Magic-Link Login

## Status

Accepted — 2026-07-23. **Implemented** the same day, alongside the password-reset flow that
[ADR-013](ADR-013-authentication-user-accounts.md) had deferred.

## Context

[ADR-013](ADR-013-authentication-user-accounts.md) settled email + password as cablegram's human
authentication, with JWT access tokens and revocable, hashed refresh tokens. Two things then made a
second, passwordless entry path worth adding as its own decision:

- **A UI will front cablegram (ADR-004 is headless, not UI-less).** Magic-link login — enter an
  email, click a one-time link — is a common expectation for such a product, and it removes password
  entry (and password reuse) from the login path entirely.
- **Password reset already builds the exact machinery a magic-link needs.** Reset required an opaque,
  hashed-at-rest, single-use, expiring email token; a system (no-newsletter) transactional mailer; and
  a way to present a token as a link or raw value. Magic-link is *the same token mechanism* pointed at
  session issuance instead of a password change. Building reset without also offering magic-link would
  leave that machinery half-used.

Magic-link is a genuinely **new authentication method**, not a refinement of an existing one, so per
the repo's one-decision-per-ADR convention it gets its own record rather than folding into ADR-013.
(Password reset, by contrast, merely un-defers an item ADR-013 already owned, so it stays there.)

## Decision

cablegram offers **passwordless login by email**, as two open `/v1` endpoints:

- `POST /v1/auth/magic-link` — takes an email. **Always returns `200 {"status":"accepted"}`**, whether
  or not the address has an account (non-enumerating, exactly like the reset request). If a user
  exists, it mints a single-use, expiring **opaque one-time token** (only its SHA-256 hash is stored)
  and emails it from the system sender identity as **transactional** mail.
- `POST /v1/auth/magic-link/consume` — takes the token, verifies it by hash (unknown / expired / used /
  wrong-purpose all rejected as one `InvalidOneTimeTokenError` → 400), **consumes it** (single-use),
  and issues a **normal session** through the very same `issueSession` helper password login uses — so
  a magic-link session and a password session are byte-for-byte identical.

Both routes are open (added to `OPEN_V1_PATHS`). The token defaults to a **15-minute** lifetime
(`MAGIC_LINK_TTL_SECONDS`).

### Shared foundation (with ADR-013's password reset)

Magic-link deliberately shares, rather than duplicates, the reset flow's parts:

- **One generic token store.** A single `one_time_tokens` collection + `OneTimeTokenRepository`, with a
  `purpose` discriminator (`password-reset` | `magic-link`) so a token minted for one flow can never be
  consumed by the other. A TTL index on `expiresAt` reaps spent/lapsed tokens; single-use and expiry
  are still enforced explicitly at consume time.
- **One opaque-token path.** The refresh-token helpers were generalized to `newOpaqueToken()` /
  `hashOpaqueToken()` (in `shared/auth`), now the single minting/hashing path for every opaque
  credential cablegram issues.
- **One transactional account mailer.** A small `AccountMailer` drives the shared `DeliveryGateway`
  (ADR-008) from the configured `SYSTEM_EMAIL_FROM_ADDRESS`, on the **transactional** message category.

### Link vs. token presentation

cablegram is headless, so a magic *link* needs a front-end URL the operator provides. `EMAIL_LINK_ENABLED`
gates this: when on, the email links to `MAGIC_LINK_URL_BASE?token=<token>` (config requires the base);
when off (default), the email carries the raw token plus the API path to submit it to. The
authoritative artifact is the **token** either way.

## Consequences

- A second login path exists with no new credential *storage* model — magic-link reuses refresh-token
  posture and the reset flow's token store, so the security surface is the one already reasoned about
  (opaque, hashed-at-rest, single-use, expiring), not a new one.
- Sessions are uniform: because consume calls the same `issueSession`, everything downstream (refresh
  rotation, logout, revocation) treats a magic-link session exactly like a password one.
- The request endpoint is intentionally non-enumerating (always 200) and does equivalent work either
  way, matching the reset request and the login timing fix — email existence is never observable.
- Trade-off: email deliverability now sits on the critical **login** path, not just recovery. A slow or
  failing transactional provider degrades sign-in for magic-link users (password login is unaffected).
  That is the accepted cost of passwordless; it is also why password login is **kept**, not replaced —
  removing passwords entirely would be a separate, later reversal of ADR-013, not this decision.

## Related

- [ADR-013](ADR-013-authentication-user-accounts.md) — Authentication & user accounts; magic-link reuses
  its one-time-token store, opaque-token helpers, session issuance, and non-enumeration posture, and
  was built together with the password-reset flow deferred there.
- [ADR-008](ADR-008-email-delivery-postmark.md) — Email delivery; account mail is transactional-category
  mail through the shared `DeliveryGateway`.
- ADR-004 — Headless (a UI consumes these endpoints; the link target is a configurable front-end URL).
- ADR-001/002/005 — the flow lives in the `accounts` component under the same layering/boundary rules.
