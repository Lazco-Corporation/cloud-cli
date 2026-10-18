# Release

A release is a `v<version>` tag on a commit that `main` holds.
The tag starts `.github/workflows/release-npm.yml`, which publishes `@lazco/cli` to npm and creates the GitHub release with the five binaries.

## What the version covers

The version follows semver for the shell only: the global flags, the output and error shapes, the `CLI_` codes, and the config file format.
A new API operation changes no version, because the commands come from the spec at run time.
`package.json` starts at `0.0.0`, and the first release is `minor`, which is `0.1.0`.
While the version is 0.x, `lazco mcp install` writes the package unpinned. From 1.0 on, it pins the major version.

## Cut a release

1. Merge everything for the release to `main`, and pull it.
2. Add a `## [<version>]` section to `CHANGELOG.md` on `main`. Its text becomes the release notes.
3. Run `bash scripts/release.sh <patch|minor|major>`, or an explicit version such as `0.2.0-rc.1`. Add `--dry-run` to run every check and print the commands instead.

`scripts/release.sh`:

- refuses a commit that `origin/main` does not hold, judged by ancestry, so a detached HEAD on a merged commit may release and an unpushed commit on `main` may not
- runs `bun run check`, `bun run type-check`, `bun run test:unit` and `bun run build`
- bumps the version with `npm version`, which commits and tags in one step
- checks that `CHANGELOG.md` has the section and that npm does not have the version yet, and undoes the local commit and tag when a check fails
- pushes the commit and the tag

Never edit the version in `package.json` by hand.

## The release workflow

| Job | Does |
|---|---|
| `guard` | `ci-actions/require-tag-on-main@v1`: refuses a tag whose commit `main` does not hold. A manual run with `dry-run` false is refused here |
| `release` | Reads the notes from `CHANGELOG.md`, runs the checks, builds the npm package and the five binaries, reads `NPM_TOKEN` from Infisical `lazco-cloud-cli` `prod` `/ci`, publishes with `ci-actions/npm-publish@v1` with provenance, and creates the GitHub release with the archives and `SHA256SUMS` |

A version with a `-` goes to the `next` dist-tag and is marked a prerelease. Every other version goes to `latest`.
Every job runs on `ubuntu-latest`.
No secret lives in GitHub: the job reads Infisical through OIDC with the identity of `vars.INFISICAL_CI_IDENTITY_ID`.

## Rehearse a release

```sh
gh workflow run release-npm.yml -R Lazco-Corporation/cloud-cli --ref main -f dry-run=true
```

The dry run does everything but the publish and the GitHub release.
It runs `npm whoami` with the publish token, runs `npm-publish` with `dry-run`, and keeps the archives, `SHA256SUMS` and the npm tarball as the artifact `release-dry-run` for 7 days.

## Check a release

- `npm view @lazco/cli@<version>` shows provenance and the dist-tag.
- The GitHub release `v<version>` holds the five archives and `SHA256SUMS`.
- `npx -y @lazco/cli --version` prints the version.
- `curl -fsSL https://raw.githubusercontent.com/Lazco-Corporation/cloud-cli/main/scripts/install.sh | bash -s -- install` installs it on macOS and Linux.
- `lazco --describe` against the API lists the commands of its spec, and needs no sign-in.

The CLI reads the spec of the API it talks to, so the API must serve `GET /v1/spec` and `GET /v1/whoami` before the release that points users at it.
