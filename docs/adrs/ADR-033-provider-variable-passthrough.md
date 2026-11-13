# ADR-033: Provider Variable Pass-Through — render what cablegram supplies, leave the rest

## Status

Accepted — 2026-11-13. **Implemented** the same day. Amends [ADR-024](ADR-024-custom-fields.md)
(`Hi {{firstName}}` no longer sends "Hi ") and [ADR-029](ADR-029-unsubscribe-handling.md) §5 step 3
(`{{{ pm:unsubscribe }}}` is no longer blanked).

## Context

Campaign content goes through Handlebars before it reaches the provider: `SendCampaign` and
`SendTestCampaign` both call `MessageRenderer.render(campaign.contentRef(), {})`. The model is always
empty — a campaign is one Bulk call with a shared body (ADR-008), and per-recipient rendering is still
undecided (ADR-024) — so the render's only visible effect was to blank every `{{…}}` in the content.

The provider has template syntax of its own in the same braces. Postmark replaces
`{{{ pm:unsubscribe }}}` with its managed unsubscribe link (ADR-029), and fills `{{FirstName}}`-style
variables from a per-message `TemplateModel`. Both were deleted before Postmark could see them, so an
author could not place Postmark's unsubscribe link, and had no way to hand Postmark a variable at all.
Escaping each one (`\{{{ pm:unsubscribe }}}`) works, but a single missed backslash silently blanks it.

## Decision

**cablegram renders the variables it supplies and passes every other variable through to the provider
unchanged.**

The renderer parses the source and, before compiling, turns each plain variable reference whose first
name is **not** a key of the model back into literal text, copied from the source exactly — braces,
spacing and triple-stash included. Variables the model does supply render as before and are still
HTML-escaped. Today the model is empty, so every variable passes through; if cablegram later supplies
values (custom fields, say), those render and the rest still pass through.

Deliberately narrow, so Handlebars keeps every guarantee it had:

- **Only bare references** — `{{name}}`, `{{name.sub}}`, `{{{ name }}}`. A helper call with arguments
  (`{{fmt date "x"}}`) still goes to Handlebars, which refuses an unknown helper rather than running
  anything; the no-code-execution guarantee is untouched.
- **Only where a name means the top-level model** — the top level, and inside `if`/`unless`. Inside
  `each`, `with` or any other section a bare name refers to the current item, so Handlebars resolves it.
- **`this`, `@data` and `../` references are always Handlebars'.**

It lives in the `templates` renderer, so it applies wherever content is rendered: real sends, test sends
(ADR-025 — still the same code path), and the syntax check on template create/update. The subject was
already sent verbatim and is unchanged.

## Consequences

- `{{{ pm:unsubscribe }}}` can be placed in a body and Postmark replaces it, so the link's position and
  wording are the author's under `UNSUBSCRIBE_HANDLING=provider`.
- Variables reach Postmark, but **cablegram sends no per-recipient values yet**, so Postmark has nothing
  to fill `{{FirstName}}` with. What Postmark does with a variable it has no value for is not verified
  here; a test send shows it. Supplying values per recipient (`TemplateModel`) is the open ADR-024
  rendering question, and this decision is a step toward answering it through the provider.
- **A typo now reaches the provider** instead of disappearing: `{{FirstNmae}}` is sent as written.
  Accepted — a visible typo in a test send is easier to catch than a silent blank.
- **Postmark block sections** (`{{#Items}}…{{/Items}}`) are not covered: Handlebars still processes them
  and, with no data, renders nothing. A marker that passes a whole region through verbatim is the
  likely follow-up if they are needed.

## Related

- [ADR-008](ADR-008-email-delivery-postmark.md) — one Bulk call, one shared body.
- [ADR-024](ADR-024-custom-fields.md) — per-recipient rendering, still open.
- [ADR-025](ADR-025-campaign-test-send.md) — the test send shares the renderer.
- [ADR-029](ADR-029-unsubscribe-handling.md) — Postmark-managed unsubscribes and `{{{ pm:unsubscribe }}}`.
