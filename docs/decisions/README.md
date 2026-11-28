# Architecture decision records

Write a record when a future maintainer would need to know why a choice was made before changing it.
Examples include who owns persisted data, when a session may change accounts, and which versions
must remain compatible. A routine fix can keep its rationale in the PR.

## Index

| Record | Status |
| --- | --- |
| [0001. Record consequential design choices in the repository](0001-record-consequential-design-choices.md) | Proposed |

## Recording a choice

1. **Propose.** Copy the template below into the next numbered file (`NNNN-short-title.md`).
   Cover one question per record and add its title and status to the index. A planning PR can merge
   a **Proposed** record while the choice is open. Link the public issue where the options were explored.
2. **Accept.** When a Palmagent maintainer explicitly agrees to the choice in an issue or PR review,
   link that confirmation and update the record and index to **Accepted**. If the choice is to
   defer work, say what would reopen it.
3. **Supersede.** When maintainers accept a replacement, mark the earlier record **Superseded** in
   both places. Preserve its reasoning and link the two records in both directions.

Track implementation in its issue or PR. Link implementation and verification evidence separately
as they become available. An accepted record can precede both. Keep current behavior in the
owning guide and link to any trade-off it already explains.

## Template

```markdown
# NNNN. Decision title

- Date: YYYY-MM-DD
- Status: Proposed

## Question and constraints

What choice needs review? What must it preserve?

## Options and rationale

Which options were considered? Which do we propose or accept, and why?

## Consequences

What does the choice cost or enable? What remains open or would prompt reconsideration?

## References

- Discussion and evidence:
- Maintainer acceptance:
- Implementation:
- Verification:
```
