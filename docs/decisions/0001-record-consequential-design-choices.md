# 0001. Record consequential design choices in the repository

- Date: 2026-11-28
- Status: Proposed

## Question and constraints

How can a contributor starting from a checkout find the reasoning behind a choice that may later
need revisiting? Planning can precede an implementation PR, and a subject guide may already explain
the trade-off.

## Options and rationale

Keeping decisions in issues and PRs costs little to maintain. For example, the reasoning behind
retaining a delivered image is available to anyone who finds the [original issue](https://github.com/incipienstation/palmagent/issues/755)
and [implementation PR](https://github.com/incipienstation/palmagent/pull/759).
Requiring a record for every change would make decisions easy to locate, but would duplicate the
PR summary for routine fixes and make consequential choices harder to find.

We propose indexing short, numbered records for choices whose trade-offs a future maintainer
will need. A proposed record gives an open question a stable home during planning, as the
[CLI and plugin compatibility discussion](https://github.com/incipienstation/palmagent/issues/481)
illustrates. When a guide already explains the reasoning, the record can point to it.

## Consequences

Authors and reviewers must decide which choices merit a record and keep its status in sync with
the index. Revisit that cost after the convention has been used on real decisions. In particular,
check whether contributors can find the rationale from a checkout and whether records duplicate
material that would be easier to maintain in a guide.

## References

The [adoption proposal and alternatives](https://github.com/incipienstation/palmagent/issues/786)
are open for maintainer review.
