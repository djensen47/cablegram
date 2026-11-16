# ADR-034: Public Signup — an open, captcha-protected subscribe route

## Status

Accepted — 2026-11-16. **Implemented** the same day. Narrows [ADR-004](ADR-004-headless-api-only.md)'s
assumption that every caller is the operator's backend, and extends
[ADR-023](ADR-023-consent-record.md)'s one request-evidence route to two.

## Context

cablegram had no way for a visitor to subscribe. `POST /v1/newsletters/{id}/subscriptions` needs an
operator JWT, so a signup form on the operator's site could not call it. Every operator therefore had to
build a backend endpoint in front of it and give that backend a cablegram login — and cablegram has no
machine credential, only user sessions with 15-minute access tokens (ADR-013). For the most basic
thing a newsletter needs, that was an unreasonable amount of work, and every operator would build it
differently.

ADR-004 and ADR-023 rested on "the caller is the operator's backend". That holds for the operator API,
and it is why evidence is passed in rather than read off the request there. It does not hold for a form
the visitor submits: on that request the caller **is** the subscriber, exactly as on the public
unsubscribe (ADR-015).

An open signup route invites abuse: with single opt-in (the default, ADR-032, because double opt-in does
not work end to end yet), anyone could subscribe any address. Rate limiting by counting requests is out:
cablegram keeps no in-process state between requests (ADR-009), and a container is replicated.

## Decision

**`POST /v1/subscribe` — open, fixed path, called from a browser form.** In `OPEN_V1_PATHS` (exact-match,
hence a fixed path with `newsletterId` in the body, as with `/v1/unsubscribe`). Body: `newsletterId`,
`email`, optional `customFields`, `captchaToken`.

1. **Cloudflare Turnstile is required.** The browser widget's token is verified server-side against
   `siteverify` (form body: secret, token, visitor IP). It is checked **before** the newsletter is looked
   up, so a bot cannot probe which newsletter ids exist. The secret is `TURNSTILE_SECRET_KEY`; without
   it the route answers **503** — off, never unprotected. A Turnstile outage, or Turnstile rejecting the
   secret, is also a 503 rather than "captcha failed", so an operator problem is not blamed on the
   visitor. A rejected token is **400** with code `captcha_failed`, so a form can ask the visitor to retry.
   Verification is a shared leaf (`shared/captcha`: `CaptchaVerifier`, `TurnstileCaptchaVerifier`),
   like `email`, so a second provider is a new adapter, not a rewrite.
2. **Each newsletter opts in** with `publicSignup`, **off** by default. An unauthenticated route is
   something an operator turns on, not something a newsletter has by existing. A closed newsletter and
   an unknown id are the same **404**.
3. **Non-revealing.** New, already subscribed, or previously left: the answer is the same
   `202 {"status":"accepted"}`, so the route cannot be used to check whether an address is on a list.
4. **A public single opt-in signup never re-subscribes an address that left** (unsubscribed, bounced,
   complained). Anyone can type any address; without a confirmation email nothing proves it was the
   owner, and overriding someone's opt-out on a guess is the one thing that must not happen. Under
   double opt-in the revival waits for the confirmation, so it is allowed. Implemented as a
   `reviveLapsedWithoutConfirmation: false` option on the ordinary `Subscribe` — not on the operator's
   HTTP schema, so an operator call is unchanged.
5. **Opt-in mode follows the newsletter** (ADR-032); a public caller cannot choose it.
6. **Evidence is read off the request** — leftmost `X-Forwarded-For` and `User-Agent`, via
   `requestEvidence()` — and the IP is also passed to Turnstile. This is now the second route, after
   `/v1/unsubscribe`, where reading the request is correct (ADR-023).
7. **Closed input.** Email plus at most 10 custom fields, keys short identifiers, values strings of at
   most 200 characters. Record-metadata names (`source`, `signupIp`, `confirmedAt`, …) are refused, so the
   public can never write — or make renderable (ADR-024/033) — provenance or consent evidence. Tags and
   status are operator-only.
8. **CORS.** `CORS_ALLOWED_ORIGINS` (comma-separated origins, validated as bare origins) lets those
   browser origins call the route cross-origin, preflight included. Unset, only same-origin pages can.

## Consequences

- A site can add a signup form with a Turnstile widget and a `fetch` to `/v1/subscribe` — no backend
  of its own, no cablegram login.
- **Abuse protection is the captcha alone.** There is no per-IP rate limit; Turnstile is what stops
  scripted signups. A determined human can still sign up addresses that are not theirs under single
  opt-in — the reason double opt-in matters once it works.
- **A host that maps env names must map the new ones.** A mounting host that passes only named
  variables (ADR-027) has to add `TURNSTILE_SECRET_KEY` and `CORS_ALLOWED_ORIGINS`, or public signup
  stays at 503 with no CORS.
- Public signups carry no `source` (cablegram collected the consent itself, the same as the operator
  subscribe), but they do carry the visitor's IP and user agent, which operator subscribes usually do not.

## Related

- [ADR-004](ADR-004-headless-api-only.md) — headless; this route is still API, not UI.
- [ADR-009](ADR-009-deployment-digitalocean-functions.md) — no in-process state, hence no in-memory rate limit.
- [ADR-015](ADR-015-public-token-unsubscribe.md) — the other open, request-evidence route.
- [ADR-023](ADR-023-consent-record.md) — when evidence may be read off the request.
- [ADR-027](ADR-027-library-entrypoint.md) — mounting; the open path is mount-relative.
- [ADR-032](ADR-032-newsletter-opt-in-mode.md) — opt-in mode, which a public signup follows.
