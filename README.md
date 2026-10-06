# Supplemental dependency updates

A GitHub Action for the dependency gaps in Dependabot: Ansible Galaxy
collections and synchronized Terraform CLI, Node, Python, and Docker image pins.
It has `check` and `update` operations with the same JSON configuration
contract. The Action reports controlled results in logs and job summaries.

`check` reads the checked-out repository and verifies image, Terraform, and
Galaxy pins. `update` runs on the trusted default branch. It reads files from
the configured accumulator branch using the GitHub API, discovers stable
releases and image digests, writes one Git commit without force pushing, and
dispatches the checks workflow. An open aggregate pull request freezes
publication.

The JSON configuration declares `branch`, `baseBranch`, `checksWorkflow`,
`toolsFile`, `dockerfile`, `collectionsFile`, `terraformRootsDirectory`, and
`enabled` (`toolchain`, `galaxy`). Paths are relative to the consumer
repository. See `action.yml` for inputs. Pin `uses:` to a tested commit SHA.

This Action is intentionally coupled to the common three-stage Dockerfile and
exact Terraform `required_version` pins. Unsupported layouts fail rather than
receiving partial updates. Development commands are in `package.json`; policy is
in `AGENTS.md`.
