# claude-remote-control connector

Drive a headless coding agent from your phone. The connector runs locally
next to a real project directory, picks up Commands from the relay, hands them
to an agent SDK, and streams the output back to your phone. The agent is either
Claude, through the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-typescript),
or GitHub Copilot, through the [Copilot SDK](https://github.com/github/copilot-sdk).

## Prerequisites

**1. Node.js 22+**

```bash
node --version   # must be >= 22
```

**2. Claude CLI installed and authenticated**

The Agent SDK runs its own bundled copy of Claude Code, but that copy uses the
login the `claude` CLI stores, so log in with the CLI before you start the
connector.

```bash
# Install
npm install -g @anthropic-ai/claude-code

# Authenticate (choose one):
claude login                  # claude.ai subscription (browser OAuth)
claude setup-token            # API key (paste your key when prompted)
```

For **Bedrock**, skip `claude login` and configure AWS credentials instead
(see [Bedrock provider](#bedrock) below). For **GitHub Copilot**, install and
sign in to the Copilot CLI instead (see [Copilot provider](#copilot) below).

**3. A running relay**

The connector needs a `relayBaseUrl` and a Connector credential minted for it
by an operator of a deployed `claude-remote-control` relay stack (see the
relay's README for how a credential is minted and revoked).

## Install

```bash
npm install
npm run build         # compiles src/ -> dist/index.js
```

Or install globally so `rc-agent` is on your PATH:

```bash
npm install -g .
```

## Configure

```bash
cp connector.config.example.json connector.config.json
# Edit: connectorCredential, and optionally projectDir (defaults to cwd)
```

### Anthropic provider (claude.ai subscription or API key)

```json
{
  "relayBaseUrl": "https://YOUR_RELAY.execute-api.us-east-1.amazonaws.com/test",
  "connectorCredential": "YOUR_CONNECTOR_CREDENTIAL",
  "projectDir": "",
  "provider": {
    "type": "anthropic"
  }
}
```

Uses whatever login `claude login` or `claude setup-token` stored. To use a
specific API key from an environment variable instead:

```json
"provider": { "type": "anthropic", "apiKeyEnv": "ANTHROPIC_API_KEY" }
```

### Bedrock provider <a name="bedrock"></a>

```json
"provider": {
  "type": "bedrock",
  "region": "us-east-1",
  "model": "arn:aws:bedrock:us-east-1:YOUR_ACCOUNT_ID:application-inference-profile/PROFILE_ID"
}
```

Both `region` and `model` are optional. Omitted (or empty), each falls back to
the ambient environment — `AWS_REGION`/`AWS_DEFAULT_REGION` and
`ANTHROPIC_MODEL` respectively — so a shell already set up for Bedrock works
with nothing but:

```json
"provider": { "type": "bedrock" }
```

A missing model falls through to the SDK's own default. A missing region has no
default, so the connector warns at startup if it can't resolve one from the
environment.

AWS credentials are resolved from the normal SDK chain (`AWS_PROFILE`,
environment variables, SSO, instance profile, or `AWS_BEARER_TOKEN_BEDROCK`).
The connector never manages credentials itself — configure them before starting:

```bash
aws configure           # static keys
# or
aws sso login           # SSO / IAM Identity Center
```

### Copilot provider <a name="copilot"></a>

```json
"provider": { "type": "copilot" }
```

Drives a GitHub Copilot agent instead of Claude. Both fields are optional:

- `model` — a Copilot model id. Defaults to `auto`, which lets Copilot pick
  one per Turn.
- `cliPath` — the `copilot` executable to run. Defaults to the one on the
  `PATH`.

By default the connector runs the installed Copilot CLI, and uses your own
login:

```bash
npm install -g @github/copilot
copilot login
```

On a machine where nobody can log in interactively, set `COPILOT_GITHUB_TOKEN`
instead. The connector then uses the Copilot SDK's bundled runtime with that
token, and ignores `cliPath`. A classic `ghp_` token is refused by Copilot.

If Copilot isn't signed in, or policy forbids a session, `rc-agent run` stops
before printing a phone URL, with Copilot's own message.

The "/" menu lists the project's Skills (from `.claude/skills` and
`.github/skills`, plus your own `~/.copilot/skills`) and Copilot's own Local
commands. There is no `/clear`, and your personal `~/.claude/skills`, written
for Claude, are not handed to Copilot.

Detached shells and background agents are Background tasks: each gets a card
and a place in the tray, and Kill ends one. Foreground shells, which Copilot
also lists, never show. When a detached shell finishes after the Turn that
started it, Copilot goes back to work on its own; the phone says "working
again: *<shell>* finished" and offers the brake, without a push. Stop, and
stopping the connector, end any detached shells still running, since Copilot
would otherwise leave them behind.

Not yet on Copilot: Fork. Tapping Fork on a Copilot session fails straight
away, with "Forking isn't available for Copilot sessions yet" on the phone, and
no worktree or branch is made.

## Run

```bash
rc-agent start            # background (recommended)
rc-agent status           # is it running? is the session alive?
rc-agent qr               # print the pairing QR (--share for the share link)
rc-agent qr --relay       # same, but the QR encodes the relay URL instead of the Netlify Control link
rc-agent stop             # stop it, leaving the session resumable
rc-agent stop --end       # stop it and end the session (destroys the conversation)

rc-agent fork <name>      # new session in a sibling git worktree, seeded with this conversation

rc-agent run              # foreground, Ctrl-C to stop
```

### Claude and Copilot in the same directory

A directory can have one running connector per Engine: a Claude one and a
Copilot one, each with its own session and phone URL. Give the second one its
own config file and pass it to every command:

```bash
rc-agent start                                   # Claude, from ./connector.config.json
rc-agent start --config ./connector.copilot.json # Copilot, same projectDir
rc-agent stop --config ./connector.copilot.json  # stops only the Copilot one
```

Both agents edit the same files, so don't point them at the same work.

## How it works

1. Registers a session with the relay (`POST /sessions`), which returns a
   session ID and bearer secret — both are embedded in the phone URL.
2. Polls `GET /sessions/{id}/commands` for new Commands from the phone and runs
   them one at a time. A Command that arrives while a Turn is running Steers
   it: the Turn is cut at its next tool-call boundary and the new Command runs
   next.
3. Commands go to an Engine, the connector's one interface over the agent SDK
   (Claude or Copilot). The Engine keeps one Conversation for the session and
   resumes it by id after a restart, so the agent keeps full context across
   Turns.
4. The Engine's output is mapped to a compact JSON event schema and
   batch-flushed to `POST /sessions/{id}/events` every ~750 ms for the phone
   to poll and render. Each Turn's token usage is sent the same way.
5. Background tasks the agent starts (background shells, subagents) show as
   cards and in the tray. When one finishes and wakes the agent into a Turn
   nobody asked for, the phone says why and offers the brake, without a push.
6. A turn that committed code reports its line counts to
   `POST /sessions/{id}/contributions`, attributed to `origin`. Measured by
   diffing the commit the turn started on against the one it ended on, and
   skipped entirely when the branch moved sideways or the directory is not a
   git repository. Turns that commit nothing send nothing.
