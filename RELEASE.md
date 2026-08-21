# Release Process

This project uses a two-step automated release system. The Release workflow prepares a release PR from `dev`, and the Publish workflow publishes after that PR is merged to `main`.

## Quick Start

1. Merge ready feature PRs into `dev`.
2. Run the GitHub Actions `Release` workflow.
3. Keep `source_branch` as `dev` unless intentionally releasing from another branch.
4. Choose `patch`, `minor`, or `major`.
5. Review and merge the generated `release/vX.Y.Z -> main` PR.
6. The `Publish` workflow runs automatically after the release PR changes `package.json` on `main`.
7. After publishing, sync `main` back into `dev` so the version bump is carried forward.

## Branch Flow

```text
feature branches -> dev -> release/vX.Y.Z -> main -> publish
```

Release branches are short-lived per-version branches. There is no long-lived `release` branch.

## What the Workflows Do

### Release Workflow

The Release workflow (`.github/workflows/release.yml`) is manually triggered. It checks out `dev` by default and runs:

```bash
bun scripts/release.ts prepare <patch|minor|major>
```

It will:

1. Create `release/vX.Y.Z` from the selected source branch.
2. Bump `package.json` to `X.Y.Z`.
3. Run `npm run build`.
4. Commit the version bump.
5. Push the release branch.
6. Open a PR from `release/vX.Y.Z` to `main`.

### Publish Workflow

The Publish workflow (`.github/workflows/publish.yml`) runs on manual dispatch or when `package.json` changes on `main`. It runs:

```bash
bun scripts/release.ts publish
```

It will:

1. Run `npm run build`.
2. Create and push the `vX.Y.Z` git tag if it does not already exist.
3. Create a GitHub release with generated release notes.
4. Publish `@jc3212/opencode-models-discovery@X.Y.Z` to npm if that version does not already exist.

## Prerequisites

### Local Releases

Local release preparation can still use the same script, but prefer the GitHub Actions workflow for normal releases.

1. **GitHub CLI** (`gh`) authenticated:
   - `gh auth login`

2. From the intended source branch, run:

```bash
bun scripts/release.ts prepare patch
```

### CI/CD Releases (GitHub Actions)

1. Configure npm trusted publishing for this repository.
2. Ensure the Publish workflow has `id-token: write` permission.
3. Run the workflow:
   - Go to: Actions -> Release -> Run workflow
   - Select version type (patch/minor/major)
   - Keep source branch as `dev`
   - Click "Run workflow"

## Version Types

- **patch**: Bug fixes, small improvements (0.1.0 -> 0.1.1)
- **minor**: New features, backwards compatible (0.1.0 -> 0.2.0)
- **major**: Breaking changes (0.1.0 -> 1.0.0)

## Manual Steps (if needed)

If automation fails, complete the same two phases manually.

### Prepare Release PR

```bash
git switch dev
bun scripts/release.ts prepare patch
```

### Publish After Merge

```bash
git switch main
git pull origin main
bun scripts/release.ts publish
```

## Troubleshooting

### npm publish fails

Common causes:

- Trusted Publishing is not configured for this repository.
- The Publish workflow is missing `id-token: write`.
- The package version already exists on npm.
- The publish step was run outside GitHub Actions without npm credentials.

### GitHub release creation fails

Ensure `GH_TOKEN` is available in GitHub Actions, or authenticate GitHub CLI locally:

```bash
gh auth login
```

### Version already exists

The publish script detects existing npm versions and skips `npm publish`. Bump to a new version if you need another release.

### dev has an old version after publishing

Merge `main` back into `dev` after the release PR is merged and published.

## CI/CD Integration

The normal CI/CD release path is:

1. Go to Actions tab.
2. Select `Release` workflow.
3. Click `Run workflow`.
4. Choose version type.
5. Keep source branch as `dev`.
6. Merge the generated release PR into `main`.
7. Let the `Publish` workflow publish automatically.

Do not run release preparation from `main` during normal development releases.
