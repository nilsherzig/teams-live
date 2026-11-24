# Agent notes

`teams-live` is a real-time Microsoft Teams daemon with GitLab, Jira, and
OpsGenie integrations.

- Use `just check` and `just build` to validate code changes. Keep live-service
  integrations behind test credentials or mocks when testing behavior.
- On an rworker, the development shell does not provide the `msteams-mcp`
  Node dependency in the checkout. After `nix develop -c just build`, run
  `ln -s result/lib/teams-live/node_modules node_modules` in the synced checkout
  before `nix develop -c just test`. Remove an existing `node_modules` only
  when it is your own disposable worker copy.
- Before changing workflows, check for reusable workflows or actions in
  [ci-workflows](https://github.com/pschmitt/ci-workflows) and preserve
  existing triggers, parameters, and check coverage.
- This repository is public. Never leak private identifiers in code, tests,
  fixtures, docs, comments or commit messages: no real GitLab, Jira or wiki
  URLs, hostnames, channel, team or project names, group paths, people's names
  or emails, ticket keys, or conversation IDs. Use generic placeholders
  (`gitlab.example.com`, `group/app`, `Alice Example`, `19:test@thread.v2`) and
  take real values from runtime configuration.
