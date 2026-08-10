Scope strings use `::` as the ONLY segment separator. A single `:` is rejected.

The canonical forms are:

- `global`
- `project::{name}`
- `repo::{owner}/{repo}`
- `branch::{owner}/{repo}::{branch}`

Note the branch form: it carries the repo AND the branch, separated by a SECOND
`::` — not by a `/`, not by a `-`. All segments are lowercased.

The mistakes that keep recurring are writing `branch:owner/repo` with one colon,
or appending the branch with a slash as `branch::owner/repo/branch`. Both are
rejected by the validator, and the rejection arrives after the work is done
rather than before it — so the write has to be redone at the end of the turn,
when the context that produced it is already gone.
