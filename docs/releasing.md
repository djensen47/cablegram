# Releasing

How a cablegram version comes into existence and lands on npm. The *why* is
[ADR-026](adrs/ADR-026-release-and-distribution.md); this file is the runbook.

**Short version:** merge PRs with conventional-commit titles → release-please opens a release PR →
merge it → the same workflow run tags, cuts a GitHub release, and publishes to npm. You never edit
`version`, `CHANGELOG.md`, or a tag by hand.

## The moving parts

| Thing | Where | Does what |
|---|---|---|
| `release-please-config.json` | repo root | release type (`node`), tag format, which commit types show in the changelog |
| `.release-please-manifest.json` | repo root | the **last released version** — the source of truth, not `package.json` |
| `.github/workflows/release-please.yml` | | opens the release PR; on merge, gates + publishes |
| `RELEASE_PLEASE_TOKEN` | repo secret | PAT the action uses, so the release PR gets CI |
| trusted publisher | npmjs.com | lets this workflow publish with **no npm token** |

## One-time setup

Three steps. None are automated, and until all three are done a release will tag but not publish.

### 1. Create `RELEASE_PLEASE_TOKEN`

A fine-grained PAT scoped to `djensen47/cablegram`, with repository permissions:

- **Contents** — Read and write (the release commit and tag)
- **Pull requests** — Read and write (open/update the release PR)

A classic PAT with the `repo` scope also works. Add it as a repository secret:

```bash
gh secret set RELEASE_PLEASE_TOKEN -R djensen47/cablegram
```

Why not `GITHUB_TOKEN`: GitHub does not fire workflows for events it raises, so the release PR would
appear with no CI run on it (ADR-026 §4).

### 2. Claim the name on npm (bootstrap publish)

npm will not let you configure a trusted publisher for a package that does not exist yet, and
`cablegram` has never been published. So publish a throwaway stub **once**, by hand, from a scratch
directory — not from this repo, which should never have a `0.0.1` in its history:

```bash
mkdir -p /tmp/cablegram-bootstrap && cd /tmp/cablegram-bootstrap
cat > package.json <<'JSON'
{
  "name": "cablegram",
  "version": "0.0.1",
  "description": "Placeholder to claim the name; see https://github.com/djensen47/cablegram",
  "license": "MIT"
}
JSON

npm login                                  # OTP if the account enforces 2FA
npm publish --tag bootstrap --access public
```

`--tag bootstrap` keeps `latest` unpointed, so `npm install cablegram` fails rather than installing a
stub. (If npm rejects a first publish that sets no `latest`, drop the flag — `1.0.0` moves `latest`
forward shortly anyway.)

Once `1.0.0` is out, retire the stub:

```bash
npm deprecate cablegram@0.0.1 "placeholder release; install >=1.0.0"
```

### 3. Configure the trusted publisher

At **https://www.npmjs.com/package/cablegram/access** → publishing access → add a trusted publisher:

| Field | Value |
|---|---|
| Provider | GitHub Actions |
| Organization / user | `djensen47` |
| Repository | `cablegram` |
| Workflow filename | `release-please.yml` |
| Environment | *(leave empty)* |

> **The workflow filename is part of the credential.** Renaming
> `.github/workflows/release-please.yml` silently breaks publishing until this setting is updated to
> match. There is a comment in the workflow saying so.

After this, publishing needs no npm secret in the repo: the workflow's `id-token: write` permission
mints a short-lived OIDC token, and every version gets a provenance attestation.

## The everyday flow

1. **Land work on `main`** through PRs whose **titles are valid conventional commits** — the PR is
   squash-merged, so the title becomes the commit release-please reads.

   | title | effect |
   |---|---|
   | `feat(campaigns): add X` | minor bump, "Features" |
   | `fix(auth): stop Y` | patch bump, "Bug Fixes" |
   | `refactor(subscriptions): rename Z` | patch bump, "Refactors" |
   | `feat(api)!: drop the Q field` | **major** bump, "⚠ BREAKING CHANGES" |
   | `docs:` / `chore:` / `test:` / `ci:` | no release |

   Squash-merge only. A merge commit puts the branch's own commits on `main` and changes what gets
   parsed.

2. **release-please opens (or updates) a release PR** titled `chore(main): release <version>`. It
   bumps `package.json`, `package-lock.json` and `.release-please-manifest.json`, and writes
   `CHANGELOG.md`. It re-opens itself on every subsequent merge, accumulating entries — so there is
   normally exactly one open at a time.

3. **Review it.** The two things worth actually reading: is the version right for what's in the diff
   (a breaking change that got a patch bump means a PR title was wrong), and does the changelog read
   like something a consumer can act on.

4. **Merge it.** That triggers the same workflow, which now: tags `v<version>`, cuts the GitHub
   release, then runs `typecheck` → `lint` → `test` → `build` → `npm publish --provenance`.

5. **Verify.**

   ```bash
   npm view cablegram version
   gh run list -R djensen47/cablegram -w "Release Please" -L 1
   ```

Nothing is deployed by any of this. A release is a tarball on npm; the consuming repo picks the
version up when it chooses to (ADR-026 §8).

## Forcing a specific version

Put a footer in the commit body (it must survive into the squashed commit on `main`):

```
Release-As: 2.0.0
```

Used for the initial `1.0.0`, since the manifest was bootstrapped at `0.0.0`. Prefer this footer over
a `release-as` key in `release-please-config.json` — a config key sticks until someone remembers to
delete it, and pins every subsequent release to the same number until they do.

## What breaks, and what it looks like

| Symptom | Cause |
|---|---|
| No release PR appears after merging to `main` | Only hidden types (`docs`/`chore`/`test`/`ci`) since the last release — correct, nothing to ship. Otherwise check the PR title actually parsed. |
| Workflow fails at the release-please step with a 401/403 | `RELEASE_PLEASE_TOKEN` is missing, expired, or under-scoped. |
| Release PR exists but has no CI checks | It was opened with `GITHUB_TOKEN` — the `token:` input is not wired to the PAT. |
| `npm publish` fails `ENEEDAUTH` / `404 Not Found` | No trusted publisher configured, or it names a different repo/workflow filename — including after renaming the workflow file. |
| `npm publish` fails `403 cannot publish over previously published version` | The version already exists on the registry. Versions are immutable; land another commit and cut the next one. |
| Release PR proposes a *lower* version than `package.json` | The `Release-As:` footer was lost in the squash. Fix the version in the release PR branch, or re-land a commit carrying the footer. |
| Published tarball is missing files | `files` in `package.json` is `["dist", "CHANGELOG.md"]`; npm adds `package.json`, `README`, `LICENSE` and `bin` targets on its own. Check with `npm pack --dry-run`. |

## Checking the artifact by hand

Before or after a release, without publishing anything:

```bash
npm pack --dry-run          # exact file list of the tarball
npm view cablegram versions # what's actually on the registry
```

The packaging itself (`files`, the `exports` map naming `./function`, `prepack`) was verified against
a packed tarball installed into a clean project — see PR #41 and
[`deployment.md`](deployment.md) for what the consumer does with it.
