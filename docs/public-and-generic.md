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
`example-owner/example-repo` and `/Users/me`.

## Nothing tied to one project

Sentinel behaves the same for every repository. Anything one project needs is
configuration that any project could set, named for what it does, never for who
asked for it. A hard-coded folder layout, framework or project name is a defect.

## How this is kept

`publicRepository.test.ts` runs with the suite and fails on a private address, a
personal path, a real email address, or a repository of the maintainer other than
this one. Names it cannot know go, one per line, in the ignored file
`.private-names`, which only a maintainer's machine holds, so the list of what is
private is never published. The rest is on whoever writes the change: read the diff
and the text around it for such names before pushing.
