# cablegram — full build-out plan

## Context

cablegram is a headless (API-only) newsletter manager/sender. Its architecture is ratified across 11
ADRs (`docs/adrs/`) and distilled into `CLAUDE.md`, and a bootable **foundation** is merged to `main`
(shared kernel, Hono app, DI, boundary lint, Prisma skeleton — no domain yet). This plan sequences the
remaining work — the five bounded contexts, the Postmark adapter, deployment, and hardening — into
**mergeable chunks**, each its own branch + PR, built **verify-then-commit** so any interruption
leaves a clean checkpoint.

Building the whole thing at once is too big to review or resume safely; hence the chunking. The order
is driven by the acyclic dependency DAG (ADR-011) and by front-loading the one chunk that sets every
convention.

## Locked decisions (from discussion)

- **API contract:** OpenAPI generated from the zod DTOs via `@hono/zod-openapi`, starting in chunk 1
  (ADR-004 — the contract is the product). No retrofit.
- **Tests:** use cases + routes are tested by DI-rebinding each repository interface to an **in-memory
  implementation** (`InMemory<X>Repository`, per ADR-003) — *not* mocks. **No real-DB / integration
  tests yet**; Prisma repositories are written but unverified against Mongo until a later explicit
  pass. Accepted trade-off: persistence adapter is trust-me-until-then; domain + API are fully covered.
- **No de-risk spike.** Postmark specifics come from its API docs when building the `email` chunk.
  Prisma-on-serverless is a documented, supported pattern (not a mystery): configure `binaryTargets`
  or `engineType="client"` (GA v6.16+, drops the Rust binary), run `prisma generate` in the build,
  pool connections. Handled in the deployment chunk with **Docker as the guaranteed fallback** (ADR-009).
- **Scheduling:** send-now only for v1; scheduled campaigns deferred to hardening (external-cron →
  `/dispatch-due` endpoint, per ADR-009's open item).
- **Boundary lint is currently incomplete** (only 2 of ADR-005's 4 rules). Completing it (layer-
  direction rule + per-component DAG) is folded into chunk 1 — otherwise the guardrail is cosmetic.

## Execution — one background Workflow, stacked PRs

The whole build runs as a **single background Workflow** (so this conversation's context is preserved;
it notifies on completion). Each of the 8 chunks is **its own phase-agent**, given a self-contained
prompt (the relevant ADR rules + that chunk's spec + the locked conventions). Runs **all 8 chunks**.

**Stacked PRs (strictly linear).** Each phase branches off the *previous* phase's branch and opens a
PR based on it — `main ← chunk-1 ← email ← deliverability ← templates ← subscriptions ← campaigns ←
deploy ← hardening`. This trades away the parallel-leaves optimization for reviewable, stacked PRs.
**Never pushes to `main`** (chunk-1 targets `main` only as a PR).

**Each phase-agent's contract:** branch off the previous branch → implement the spec + conventions →
run `typecheck`/`lint`/`test` until green → commit → push → open a PR based on the previous branch →
return `{ branch, prUrl, status }`.

**Per-phase model / effort:**

| phase | model · effort |
|---|---|
| newsletters (reference + lint + OpenAPI) | Opus · xhigh |
| email (Postmark adapter) | Opus · high |
| deliverability | Sonnet · medium |
| templates | Sonnet · high |
| subscriptions | Opus · high |
| campaigns | Opus · xhigh |
| deploy | Sonnet · high |
| hardening | Sonnet · high |

**On failure:** a red build (typecheck/lint/test) gets a couple of self-fix retries, then the chain
**stops cleanly**; an API/usage death stops immediately (a cap can't be retried past). Completed PRs
stay intact.

**Resume (answers the usage-cap worry):** the chain never auto-waits on a cap. It resumes when you
say so — same session, instantly from the Workflow's `runId` cache; a later/new session, from git
(every completed chunk is a pushed PR), by authoring a continuation from the last completed branch.
Git is the durable checkpoint; nothing built is lost.

## Conventions locked in chunk 1, then copied by every context

- Component skeleton: `src/<component>/{domain,application,infrastructure,presentation}/` + `index.ts`
  facade + `types.ts` (component DI tokens).
- Cursor pagination (`_id`-based): `{ data, meta: { nextCursor } }`.
- Error body: `{ error: { code, message, details, requestId } }` (already in `shared/http`).
- zod DTO ⇄ `@hono/zod-openapi` route definitions; use cases take plain typed DTOs (validation at edge).
- Test double: `InMemory<X>Repository` implementing the repo interface, rebound via DI.
- Light branded id alias per component (`type NewsletterId = Id`) for compile-time safety; still a
  plain string `_id` (no `ObjectId`, ADR-007).

## Chunks

### 1 — `newsletters` context (reference vertical) + finish boundary lint + OpenAPI wiring — size L
- **Goal:** establish the canonical component pattern end-to-end; complete ADR-005 enforcement; wire OpenAPI.
- **Deliverables:** `Newsletter` entity + sender-identity VOs (from-name/email, reply-to, sending
  domain/DKIM fields, ADR-011); `NewsletterRepository` (application); create/get/list/update/delete
  use cases; `PrismaNewsletterRepository` + `InMemoryNewsletterRepository`; Prisma `Newsletter` model;
  `/v1/newsletters` routes with zod-OpenAPI DTOs; `ContainerModule` + `types.ts`; cursor-pagination
  helper; domain-error→`AppError` mapping; extended `eslint.config.js` (layer + DAG rules); `/openapi.json`.
- **Key files:** `src/newsletters/**`, `prisma/schema.prisma`, `src/app.ts`, `src/shared/di/container.ts`,
  `eslint.config.js`, a shared pagination helper in `src/shared/http`.
- **Exit:** full CRUD green via in-memory repo; typecheck/lint/test clean; a deliberately-wrong
  cross-layer or `newsletters→campaigns` import **fails lint**; `/openapi.json` serves.

### 2 — `email` shared module (Postmark ACL) — size M (external-contract risk)
- **Goal:** send + inbound webhook normalization, docs-pinned, with a test double.
- **Deliverables:** `DeliveryGateway` interface; `PostmarkDeliveryGateway` (Bulk send via raw `fetch`;
  any per-call limit/split is an internal detail, ADR-008); `parseProviderEvent(raw)→DeliveryEvent[]`;
  `FakeDeliveryGateway`/`InMemoryDeliveryGateway` for tests; `ContainerModule`; unit tests over real
  Postmark payload fixtures.
- **In-chunk decisions:** confirm exact Bulk endpoint + limits and the **webhook auth mechanism**
  (likely HTTP Basic on the callback URL — reconcile `POSTMARK_WEBHOOK_SECRET` in `config.ts`) against
  live docs; raw `fetch` over the `postmark` SDK (thin, bundling-friendly).
- **Key files:** `src/shared/email/**`.
- **Exit:** send maps a recipient set to the correct payload (unit); `parseProviderEvent` covers
  delivered/hard-bounce/complaint/open/click fixtures; fake rebindable. **Must precede subscriptions.**

### 3 — `deliverability` context (suppression) — size S  ·  4 — `templates` context — size M
- **Deliverability:** global address-keyed suppression list (reason taxonomy: hard-bounce / complaint
  / manual-junk / global-opt-out); `SuppressionRepository` with a **batch `filterSuppressed(addresses[])`**
  (the send path needs it); add/check/list/remove; `/v1/suppressions`; address-unique index.
- **Templates:** `Template` entity; `TemplateRepository`; `TemplateRenderer` interface + default impl;
  CRUD + `render(template, model)→{html,text}`; `/v1/templates`. **Decision:** engine = logic-limited,
  sandboxed (recommend Eta/Handlebars behind the interface; treat template source as untrusted; defer MJML).
- Both are **leaves** — parallelizable with each other and with `email`.
- **Shared normalizer:** add a tiny `src/shared/email-address` leaf (lowercase/trim policy) used by
  BOTH deliverability and subscriptions so suppression keys always match subscription keys.

### 5 — `subscriptions` context — size L
- **Goal:** flat, per-newsletter, independent membership (email-as-field, no Contact identity, ADR-011).
- **Deliverables:** `Subscription` entity (email, fields, status subscribed/pending/unsubscribed,
  segment tags); `SubscriptionRepository` with `resolveRecipients(newsletterId, segment?)`;
  subscribe/confirm/unsubscribe/list use cases; double-opt-in confirmation email via `email.send`;
  Prisma model (compound unique index on `newsletterId` + normalized email); `/v1/newsletters/:id/subscriptions`.
- **Decisions:** per-newsletter single/double opt-in toggle; query-time tag/predicate segments (not
  materialized); re-subscribe = revive.
- **Depends on:** `newsletters` + `email`. **Exit:** `resolveRecipients` returns only subscribed; DOI
  sends one transactional email via the fake; unique index enforced.

### 6 — `campaigns` context (integrator) — size L — HIGHEST RISK
- **Goal:** campaign aggregate + lifecycle + full send-now pipeline + webhook receiver + send record.
- **Deliverables:** `Campaign` aggregate (belongs-to newsletter, optional template ref + inline
  content, targeting, status draft→sending→sent/failed); `CampaignRepository`; **send use case**
  (resolve recipients → filter suppression → render → one `email.send`); send record (per-recipient
  outcomes + aggregate stats); **webhook handler** (`email.parseProviderEvent` → record outcome;
  hard-bounce/complaint → `deliverability` add); `/v1/campaigns` + **`/webhooks/postmark` mounted at
  top level with its own auth (NOT `/v1` API-key)**.
- **Decisions:** send idempotency = status-guard + persisted `sendId`, write `sending` before the API
  call, reconcile via webhooks; webhook idempotency = upsert keyed on (messageId, eventType);
  suppression enforced in the send use case, never in `email` (ADR-008); minimize cross-document
  transactions (ADR-007).
- **Depends on:** all four contexts + `email`. **Highest risk** — concentrates the DAG, both external
  contracts, idempotency, and the txn constraint; a wrong upstream contract surfaces here.

### 7 — Deployment (Docker-first, then DO Functions) + CI — size M
- **Deliverables:** multi-stage Dockerfile (`@hono/node-server`); GitHub Actions (typecheck/lint/test
  on PR); DO Functions build config; Prisma for the target runtime (`binaryTargets` **or**
  `engineType="client"`; `prisma generate` in build; `prisma db push` for Mongo schema sync — no
  migration files); connection pooling.
- **Exit:** `/health` responds from a Docker container built from source; CI gates PRs; DO Functions
  deploy attempted (Docker is the fallback if bundling fights back).

### 8 — Hardening — size L
- Scheduled campaigns (schedule field + external-cron `/dispatch-due`); **integration test pass**
  against a real Mongo replica set (decide `mongodb-memory-server` vs testcontainers then); structured
  logging; Idempotency-Key on mutating routes; OpenAPI polish.

## Sequence

Strictly linear because the PRs are stacked (each branch bases on the previous):
`1 newsletters → 2 email → 3 deliverability → 4 templates → 5 subscriptions → 6 campaigns → 7 deploy →
8 hardening`. This order respects every DAG edge (newsletters and email both precede subscriptions and
campaigns); the leaves that *could* run in parallel are serialized to keep the stack clean.

## Verification (every chunk)

`npm run typecheck && npm run lint && npm test` green; `/openapi.json` builds; app boots; new routes
exercised end-to-end through in-memory repos (no DB). Each chunk = branch + PR, committed only when green.

## Open naming note

The mail gateway is `DeliveryGateway` (ADR-008). Trivially renamable to `MailGateway`/`EmailGateway`
if preferred — say so before chunk 2 and I'll sweep ADR-008/011 + CLAUDE.md + code.
