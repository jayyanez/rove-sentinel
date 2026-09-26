# Release discovery and update pull requests

Status: planned; implementation belongs to this pull request.

## Outcome

Help users discover newer stable Sentinel releases and propose explicit consumer
updates without changing the running review engine automatically.

## Delivery

- Add update-check with stable-release validation, bounded network access,
  persistent cache, offline behavior and machine-readable results.
- Include a best-effort update notice in status and doctor, with opt-out.
- Supply an opt-in scheduled GitHub Actions workflow that proposes a draft PR
  updating a consumer manifest and lockfile, without executing package scripts,
  installing a watcher, merging, or running provider reviews.
- Preserve existing automation branches and human edits; avoid duplicate PRs.
- Document release subscriptions, setup permissions, review and canonical
  watcher activation, including behavior of GITHUB_TOKEN-created PR checks.
- Cover offline, malformed-response, cache, version ordering, update preparation
  and automation safety behavior. Run full tests, package acceptance and review.
- Publish a new version after acceptance, then adopt it and the workflow in Rove
  through its own planning/implementation PR and merge authorization.

## Boundaries

Use public GitHub Releases as the authoritative distribution source. Do not
send repository content or provider credentials for update discovery. Updates
remain version-pinned and reviewed; notification failures never block reviews.
The automation uses GitHub Actions and gh, with no external bot installation.
Maintainers must explicitly enable Actions PR creation where required.

## Next action

Implement the release client and regression suite, then the opt-in consumer PR
workflow and onboarding documentation. The existing v1.9.0 release is immutable.
