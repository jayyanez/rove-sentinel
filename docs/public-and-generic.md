# Public and generic

Rove Sentinel is a public project that any GitHub repository can adopt. Two rules
follow from that, and they bind every change, by people and by agents alike.

## Nothing private

Everything here can be read by anyone, for ever: files, tests, comments, commit
messages, pull requests, review comments, release notes and published packages.
None of them may hold anything about a private project or a person's setup:

- the name of a consumer project, repository, product or series;
- a machine's name, a private address, a path on someone's computer;
- an account, or an email address that is not an example.

To say where a finding came from, say "a consumer project". Tests use names such as
`example-owner/example-repo` and `/Users/me`, and put a URL with credentials on an
example host: `https://token:secret@example.com/owner/repo.git`.

## Nothing tied to one project

Sentinel behaves the same for every repository. Anything one project needs is
configuration that any project could set, named for what it does, never for who
asked for it. A hard-coded folder layout, framework or project name is a defect.

The Clippy lane finds crates by their `Cargo.toml` or by `clippyCrates`, and
`guiEvidence: "required"` is named for what it does; `rove` remains only as the
earlier spelling, so that no installed policy breaks. Still tied to one layout: the
GUI evidence check's folders and file patterns, and a few folder names in the review's
default risk and shard lists, which change only how a change is reviewed.

## How this is kept

`publicRepository.test.ts` runs with the suite and makes one set of checks on two
things:

- the contents of every tracked file, working copy and staged copy, except `.tgz`
  and `.png` files, the lockfile and the third-party notices, the last two
  generated, and itself, which holds the patterns;
- the pathname of every tracked file, those skipped for content and itself
  included.

The checks fail on:

- a tailnet address or tailnet name;
- a private IPv4 address, or a unique-local or link-local IPv6 address, written in
  full, compressed, or ending in IPv4;
- a personal folder on Windows, macOS or Linux;
- an email address, unless it is one of the synthetic ones: any at an example domain
  (`example.com`, `example.net`, `example.org`, or a name under `.example`, `.test`
  or `.invalid`), `git@github.com`, `noreply@anthropic.com`, or any at
  `users.noreply.github.com`. No other address at GitHub or Anthropic is allowed,
  and a `noreply.` domain earns nothing;
- another repository of the maintainer's that is not public;
- a line of the ignored file `.private-names`, matched in any case. Names the test
  cannot know go there, one per line, and only a maintainer's machine holds it, so
  the list of what is private is never published.

A failure never prints what matched, because CI logs are public. It names the check
and, for a name from the list, its entry number, and it names the file, or, when the
file's own pathname fails a check, only that pathname's place in `git ls-files`
(`tracked pathname #12`). Find it locally.

The rest is on whoever writes the change: read the diff and the text around it for
such names before pushing.
