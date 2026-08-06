# ADR-026: Release & Distribution — release-please, npm, and trusted publishing

## Status

Accepted — 2026-08-05.

## Context

[ADR-009](ADR-009-deployment-digitalocean-functions.md) fixed the *runtime* targets: a Docker image
and a DigitalOcean Functions raw web action. It never said how a **version** comes into existence.
The packaging work that made cablegram installable (PR #41 — `files: ["dist"]`, an `exports` map
naming `./function`, `prepack: npm run build`) produced a publishable artifact and stopped there. So
the repo could build a tarball nobody had a procedure for cutting.

That gap matters more here than it would in an application repo, because **this repo is not a
deployment**. The plan for shipping cablegram is a *separate* repo that declares `cablegram` as a
dependency, `npm install`s it, and re-exports the handler as its DO function. The alternative —
building the action in-repo from `packages/cablegram/api/build.sh` — was tried and abandoned: a DO
function's `build.sh` may only reference its own directory or `lib/`, and App Platform builds
remotely, where that restriction is actually enforced. **npm is therefore the distribution seam**,
not a convenience, and an unmanaged seam means hand-edited `version` fields, hand-pushed tags, and a
changelog nobody writes.

### What a release process has to decide

Three questions, each with a real fork:

1. **Who picks the version?** A human typing `npm version minor` will eventually type it wrong, or
   ship a breaking change as a patch. Deriving it from commit messages removes the judgement call —
   but only if the commit messages are trustworthy.
2. **Is the version chosen before or after review?** `semantic-release` publishes straight off a
   merge to `main`: the first time you see the version and changelog, they are already on the
   registry, and npm forbids re-publishing a version. `release-please` and `changesets` both put a
   reviewable artifact in front of a human first.
3. **What credential does CI hold?** A classic npm automation token in a repo secret is a
   long-lived, exfiltratable publish capability on a public package — the exact shape of credential
   behind the 2025 npm supply-chain compromises.

The commit history answered (1) for us: **every commit in this repo already parses as a conventional
commit**, across 40+ commits and 25 ADRs, with no enforcement tooling. That is a convention already
paid for, and it makes commit-derived versioning free rather than a new discipline to impose.

## Decision

**release-please** derives the version and changelog from conventional commits and proposes them as
a pull request; merging that PR tags a release; the same workflow run then publishes to npm using
**trusted publishing (OIDC)**, with no npm credential stored in the repository.

This is not a novel arrangement — it is the setup already running in a sibling repo
(`djensen47/sabre-rest`, publishing with OIDC provenance since v0.x), transplanted rather than
invented.

### 1. release-please in manifest mode, one package at the root

`release-please-config.json` + `.release-please-manifest.json`, `release-type: node`,
`include-component-in-tag: false` (so tags are `v1.2.3`, not `cablegram-v1.2.3` — there is one
package, and a component prefix would only be noise).

Manifest mode is used even for a single package because the manifest, not `package.json`, is the
recorded "last released version". That distinction is what lets the version live in git rather than
being inferred from the registry.

### 2. Conventional commits and squash-merge are load-bearing

PRs are **squash-merged**, and the PR title becomes the squashed commit subject — so **the PR title
must be a valid conventional commit**. `feat:` → minor, `fix:`/`perf:` → patch, `!` or a
`BREAKING CHANGE:` footer → major. A merge commit instead of a squash puts the branch's individual
commits on `main`, which changes what release-please reads; don't do it.

This is the one place the process can silently produce a wrong version, so it is stated as a rule
rather than left to habit.

### 3. The changelog shows `refactor`, not just `feat` and `fix`

Default conventional-changelog hides `refactor`. That default is wrong for this repo:
`refactor: rename mergeFields to customFields` ([ADR-024](ADR-024-custom-fields.md)) renamed a wire
DTO with no alias and no deprecation window, and `refactor(campaigns): remove the stored stats
snapshot` ([ADR-019](ADR-019-per-recipient-outcome-documents.md) §7) deleted a response field. Those
are consumer-visible by any reasonable definition. `changelog-sections` therefore surfaces `feat`,
`fix`, `perf`, `refactor` and `revert`, and hides `docs`/`chore`/`test`/`build`/`ci`.

The honest caveat: a hidden `docs:` commit still bumps nothing, so a docs-only week produces no
release. That is correct — there is nothing to ship.

### 4. One workflow, not a release workflow plus a publish workflow

The obvious decomposition (release-please writes a tag; a `publish.yml` triggers `on: push: tags`)
**does not work**. GitHub deliberately does not fire workflows for events raised by `GITHUB_TOKEN`,
so the tag would land and nothing would react. So publishing lives in the *same job*, with every
step after the action gated on `if: steps.release.outputs.release_created`.

For the same underlying reason, the action is given a **PAT (`RELEASE_PLEASE_TOKEN`)** rather than
`GITHUB_TOKEN`: a release PR opened by `GITHUB_TOKEN` would show no CI run at all. Accepting a
second credential here is a deliberate trade — it buys CI on the artifact that is about to be
published.

### 5. npm trusted publishing (OIDC) — no npm token in this repository

The workflow requests `id-token: write`, and `npm publish` exchanges a short-lived GitHub OIDC token
for a registry credential scoped to this repo and this workflow file. There is no `NODE_AUTH_TOKEN`
and no npm secret. A provenance attestation is generated (automatic under OIDC; `--provenance` is
passed explicitly anyway, so the intent survives a future change of auth method).

The cost is a coupling that is invisible in the code: the trusted publisher is registered against
**this workflow's filename**. Renaming `release-please.yml` breaks publishing until the setting at
npmjs.com is updated to match — which is why that fact is a comment in the workflow itself.

npm requires a package to **already exist** before a trusted publisher can be configured (unlike
PyPI, which allows pre-registration). `cablegram` was unpublished, so the name is claimed by one
manual publish of a throwaway `0.0.1` stub under a non-`latest` dist-tag, after which OIDC is
configured and every subsequent version is machine-published. The stub is deprecated once `1.0.0` is
out. That one-time wart is preferred over keeping a long-lived npm token around forever, which was
the only alternative that avoided it.

### 6. The release job re-runs the full green gate

`typecheck`, `lint`, `test`, `build` run again against the release commit before `npm publish`, even
though CI already ran them on the PR. The release commit is a *different* commit (release-please
rewrote `package.json` and `CHANGELOG.md`), the publish is irreversible — npm forbids re-publishing a
version — and `build` in particular is what proves `dist/` compiles at all. `prepack` rebuilds a
second time as a backstop against a stale `dist/`; a duplicated `tsc` run is a trivial price.

`test:integration` is **not** in the release gate, matching the default gate in `CLAUDE.md`: it
downloads a `mongod` binary and tests a persistence contract that a version bump cannot change.

### 7. The first release is 1.0.0

`package.json` already carried `1.0.0` from PR #41 and nothing was ever published, so the number is
unclaimed. The manifest is bootstrapped at `0.0.0` and the setup commit carries a `Release-As: 1.0.0`
footer — a one-shot override, chosen over a `release-as` key in the config precisely because a config
key would have to be remembered and removed later.

Consequence: the initial CHANGELOG is generated from the **entire** history, since there is no prior
tag to scan back to. That is a feature for a 1.0.0 — the record of how the thing got here is worth
having — and never recurs.

### 8. Scope: this releases the npm package, and nothing else

No Docker image is built, tagged, or pushed by this process, and nothing is deployed. Releasing
produces a tarball on npm and a GitHub release; the consuming repo decides when to pick a version up.
Keeping deployment out of the release path is what keeps this repo the OSS project rather than an
environment.

## Consequences

**Easier.** The version and changelog stop being someone's judgement call. A release is a PR review
plus a merge, so the changelog is read by a human *before* it is permanent. There is no npm
credential to rotate, revoke, or leak, and every published version carries a provenance attestation
tying it to a specific commit and workflow run. The DO Functions consumer can pin a version and
upgrade deliberately.

**Harder.** A wrong PR title silently produces a wrong version — the process is only as good as the
commit discipline, and nothing mechanically enforces conventional commits (no commitlint hook; the
repo's own history is the evidence that one is not yet needed). Two credentials now exist that the
code cannot see: the `RELEASE_PLEASE_TOKEN` secret, and a trusted-publisher setting at npmjs.com keyed
to a filename. Both fail in ways whose cause is not visible in the diff, which is why
[`../releasing.md`](../releasing.md) exists as a runbook rather than a paragraph in the README.

**Accepted trade.** A one-time placeholder `0.0.1` will exist on the registry forever (deprecated),
because npm cannot configure trusted publishing for a package that does not exist. The alternative
was a long-lived token, which is the thing this decision is mostly about avoiding.

**When a different choice would be better.** If cablegram ever ships more than one package from this
repo, `changesets` becomes the stronger option — it is built around independently versioned packages
and per-change intent, where release-please's manifest mode handles multi-package layouts but assumes
commit-derived versions. That is a monorepo decision, not a today decision.

## Related

- [ADR-027](ADR-027-library-entrypoint.md) — **supersedes this ADR's original note that there is no
  `"."` entry.** There is one now: a barrel a host service mounts (issue #44). The reason given here —
  "there is no library surface to release" — is precisely what changed; ADR-027 fixes what that
  surface may contain.
- [ADR-004](ADR-004-headless-api-only.md) — why the published package exposes the HTTP app, the
  `./function` handler and the `cablegram` bin, and nothing that reaches past the API surface.
- [ADR-028](ADR-028-containers-only.md) — the Functions target this ADR's context assumes (a deploy
  repo that "re-exports the handler as its DO function") is retired; a deploy repo now mounts or runs
  the app. Removing the `./function` export is why ADR-026's commit-derived versioning cut a major.
- [ADR-009](ADR-009-deployment-digitalocean-functions.md) — the deployment targets this package feeds
  (superseded by ADR-028 as to *which*).
- [ADR-016](ADR-016-cli-client.md) — the CLI ships inside the same tarball, as `bin`.
- [`../releasing.md`](../releasing.md) — the runbook: one-time setup, the everyday flow, and what
  breaks when a credential is missing.
- [release-please](https://github.com/googleapis/release-please) ·
  [npm trusted publishing](https://docs.npmjs.com/trusted-publishers)
