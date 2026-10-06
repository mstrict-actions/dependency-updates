# Agent guide

This Action updates supplemental runtime and Ansible Galaxy pins for a trusted
repository. `check` and `update` share a JSON configuration. Changes to path
discovery or release selection must preserve their agreement.

## Change procedure

Inspect Git status, package scripts, action metadata, tests, and the consumer
configuration. Update domain policy, API adapter, tests, README, and `dist`
together. On the supported Node major run `npm ci`, `npm run check:ci`, and
`npm run build`; after committing a new bundle run `npm run check-dist`. Use
English Conventional Commits. When pushing, verify CI, Version, and both CodeQL
categories for the pushed commit.

## Update contract

Only stable releases may advance pins. Verify image digests, reject downgrades,
partial source layouts, unexpected pagination origins, and stale accumulator
refs. Freeze when an aggregate pull request is open. Publish one commit with a
non-forced ref update; dispatch checks after publication. Keep GitHub
credentials in the privileged update job and use `check` without a write token
in validation jobs.

No private infrastructure values belong in fixtures, logs, summaries, or action
defaults. Tests cover version ordering, formatting, failures, and standalone
bundles outside `node_modules`. Apply the shared strict dev-tools policy;
exceptions must be local and justified.

## Specialized instructions

- For workflow changes or review, read
  [github-actions-hardening](.agents/skills/github-actions-hardening/SKILL.md).
- For runtime upgrades, read
  [github-actions-runtime-upgrade-conventions](.agents/skills/github-actions-runtime-upgrade-conventions/SKILL.md).
- For CodeQL configuration or alerts, read
  [codeql](.agents/skills/codeql/SKILL.md).
- For this guide or skills, read
  [writing-for-agents](.agents/skills/writing-for-agents/SKILL.md).

[Skill provenance](.agents/README.md) records fixed snapshots. Pin external
Actions to full SHAs with version comments.
