## What is this about?
<!-- Give a small description related to the changes you have made -->

## Related Jira task/s
<!-- Add associated JIRA links -->

## Release (mandatory for every PR — required for the `ready-for-review` label)
<!-- CI gates the `ready-for-review` label on the **version bump** and the **internal release notes** below. Customer-facing notes + type are optional but strongly encouraged for the daily release. The changeset is generated automatically from this section (`.changeset/pr-<number>.md`) — you do NOT need to run `npx changeset`. Label the PR `skip-changeset` for CI/docs/chore PRs that shouldn't be released. -->

**Version bump:** *(required — tick exactly one)*
<!-- minor = ANY new feature/capability (backwards-compatible). patch = bug fix or trivial change only. New features mislabeled as patch is the common mistake — when unsure, choose minor. -->
- [ ] minor (backwards-compatible feature)
- [ ] patch (bug fix or other small change)

**Release notes type:** *(optional)*
- [ ] New Feature
- [ ] Bug Fix
- [ ] Other Improvement

**Release notes (customer-facing):** *(optional but encouraged)*
<!-- 1-3 bullets in customer language, e.g. "Fixed test results not being reported when using the CLI." -->
- 

**Release notes (internal):** *(required — engineer-facing; what actually changed / why)*
<!-- REQUIRED: at least one non-empty bullet — the ready-for-review gate checks this. Dev-facing notes for the internal CHANGELOG.md (non-customer-facing). -->
- 

## Checklist
- [ ] Ready to review
- [ ] Has it been tested locally?

## PR Validations
Run Tests: Comment RUN_TESTS to trigger sanity tests.
