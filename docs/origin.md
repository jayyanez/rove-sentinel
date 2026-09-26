# Origin and real-world use

Rove Sentinel grew out of the review system used to develop **Rove**, an
upcoming desktop application built around a Mosaic Workspace.

The original system is already part of Rove's development workflow. It reviews
committed changes before a push, records findings and their disposition, and
keeps a local review result associated with the exact change and policy.

## Used across hundreds of pull requests

The original review workflow has been used across **hundreds of Rove pull
requests**. A maintainer check on September 25, 2026 found its status comments
on **207 distinct pull requests** in Rove's private repository.

This measures workflow adoption, not review accuracy or 207 successful model
reviews. The records include 190 non-skip, non-error review outcomes, 15
documentation-only skips, and two technical errors. Comments can be updated
as a pull request evolves, and a pull request can receive multiple review
rounds. These counts are a dated snapshot, not a benchmark or a count of
defects prevented.

The underlying pull requests are private. Their source, review contents,
identifiers, and user data are not published here.

## Relationship to Rove

Rove Sentinel currently operates in its original, repository-integrated form
inside Rove. This public repository is the home for its extraction into an
independent tool.

After the standalone implementation is released and validated, Rove is intended
to consume a pinned version as a development dependency. Rove will retain its
own project rules, tests, design evidence, and application-specific checks.
The reusable review engine will be maintained in Rove Sentinel.

Publishing Rove Sentinel does not publish or relicense the Rove application.

## Rove's forthcoming website

Rove is an upcoming application and has not been publicly released.

**Planned website:** `https://11kites.com/rove`

**Website status:** not live yet.

This address identifies the intended future home of Rove. It is not a download,
documentation, or support link at this stage. This document and the README
should be updated when the website actually launches.
