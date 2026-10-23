# claude-remote-control connector

When asked to make sure the connector is installed and working, run
[Verify an install](README.md#verify-an-install) step by step. It is done only
when every box in its "Summary of pass criteria" checklist is ticked.

## Bumping SDK versions

The Claude, Copilot and Pi SDKs are pinned, and each has a contract test under
`test/contract/` that runs the adapter against the real pinned package. After a
bump, run `npm run test:contract` with a live credential for the SDK you
bumped. For Pi (`@earendil-works/pi-agent-core`, `pi-ai` and `pi-coding-agent`,
bumped together), `pi.contract.ts` needs `ANTHROPIC_API_KEY`, a `pi` login for
anthropic or github-copilot, or AWS credentials for Bedrock. Without one it
skips, which is not a pass. It runs in a throwaway Pi home, so it never writes
to `~/.pi`.
