# claude-remote-control connector

When asked to make sure the connector is installed and working, run
[Verify an install](README.md#verify-an-install) step by step. It is done only
when every box in its "Summary of pass criteria" checklist is ticked.

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature-slug>/`, not GitHub Issues (despite the GitHub remote). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical roles (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), recorded as a `Status:` line on each issue file. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/` (created lazily by `/domain-modeling` when needed — neither exists yet). See `docs/agents/domain.md`.
