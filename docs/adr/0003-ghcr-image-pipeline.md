# ADR-0003: Container images on GHCR, built by GitHub Actions

- Status: Accepted
- Date: 2026-10-18

## Context
The project should be easy to deploy and easy to test on every change, without
requiring maintainers to manage registry credentials.

## Decision
- Publish to GitHub Container Registry: `ghcr.io/fubarpie/riffle-accounting`,
  authenticated with the built-in `GITHUB_TOKEN`.
- Every build of the image, including pull requests from this repository, goes
  through the same gates in order: build, smoke test, vulnerability scan, then
  push.
  1. Build a local `linux/amd64` image.
  2. Run `scripts/smoke.sh` (compose stack, health checks, non-root check).
  3. Scan with Trivy; fail on fixable CRITICAL vulnerabilities.
  4. Only then build and push multi-arch (`linux/amd64`, `linux/arm64`) with
     SBOM and provenance attestations.
- Tags: `latest` and `main` (default branch), `sha-<short>`, `pr-<n>`, and
  semver (`1.2.3`, `1.2`) for `v*` tags.
- Pull requests from forks build and test but never push, since they have no
  access to packages write permission.
- Workflow permissions are least-privilege, declared per job.

## Consequences
- A broken or vulnerable image is never published.
- Anyone can test a PR by pulling `pr-<n>` and running `docker compose up`.
- Third-party actions are pinned in two tiers. The Trivy scanner action, which
  runs against our build artifacts, is pinned to a full commit SHA with the
  release version in a trailing comment (`# v0.36.0`). The remaining actions
  (GitHub-owned and Docker-maintained) are referenced by major version tag
  (for example `@v4`). Dependabot updates both forms. Moving the remaining
  actions to commit SHAs is a possible later hardening step.
