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

To check an install end to end, follow [Verify an install](#verify-an-install).

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

## Verify an install

Run every step in order. Each one has a pass/fail check; fix a failing
check and re-run it before moving to the next step.

### Step 1 — Node.js version

```bash
node --version
```

**Pass:** printed version is `v22` or higher.
**Fail:** install Node.js 22+ before continuing. Do not proceed with an older version.

**Running Node 24 in cluster:** set `NODE_USE_ENV_PROXY=1` in the environment
now, before any later step talks to the relay. Without it, cluster's proxy
setup makes those requests come back `HTTP 403`.

### Step 2 — Provider CLI installed and on PATH

Determine the provider type from `connector.config.json` (or ask the user if the
file doesn't exist yet). Steps 2 and 3 depend on it.

- **`anthropic`** — the Agent SDK runs its own bundled copy of Claude Code, but
  that copy uses the login the `claude` CLI stores, so the CLI is needed to log in:
  ```bash
  which claude && claude --version
  ```
  **Fail:** install it with `npm install -g @anthropic-ai/claude-code`, then re-check.
- **`bedrock`** — no CLI needed; skip to Step 3.
- **`copilot`** — the connector runs the installed Copilot CLI by default:
  ```bash
  which copilot && copilot --version
  ```
  **Fail:** install it with `npm install -g @github/copilot`, then re-check. (Not
  needed if the machine will use `COPILOT_GITHUB_TOKEN` — see Step 3.)

**Pass:** the commands for this provider succeed and print output.

### Step 3 — Provider authenticated

- **`provider.type: "anthropic"`** — run:
  ```bash
  claude auth status
  ```
  Check that `"loggedIn": true` appears in the output.

  If not logged in, choose the right method for this machine:
  - **Desktop / machine with a browser:** `claude login` (opens browser OAuth)
  - **Headless VM (no browser):** `claude setup-token` — follow the prompts to
    paste a token from https://claude.ai/settings, **or** set
    `ANTHROPIC_API_KEY` in the environment and add
    `"apiKeyEnv": "ANTHROPIC_API_KEY"` to the `provider` block in
    `connector.config.json`.

  Re-run `claude auth status` after authenticating to confirm.

- **`provider.type: "bedrock"`** — run:
  ```bash
  aws sts get-caller-identity
  ```
  **Pass:** returns a JSON object with `Account`, `UserId`, `Arn`.
  **Fail:** ask the user to configure AWS credentials (`aws configure`, `aws sso login`,
  or set `AWS_PROFILE`) before continuing.

- **`provider.type: "copilot"`** — the Copilot CLI has no status command; the
  connector checks the login itself at startup, and `rc-agent start` (Step 11)
  fails before printing a phone URL, with Copilot's own message, if nobody is
  signed in. Make sure one of these is true:
  - **Desktop / machine with a browser:** the user has run `copilot login`.
  - **Headless VM:** `COPILOT_GITHUB_TOKEN` is set in the connector's
    environment. The connector then uses the Copilot SDK's bundled runtime and
    ignores `cliPath`. A classic `ghp_` token is refused by Copilot.

### Step 4 — npm install

```bash
npm install
```

**Pass:** exits 0. Ignore audit warnings.
**Fail:** show the error and stop. Do not proceed with a broken install.

### Step 5 — TypeScript typecheck

```bash
npm run typecheck
```

**Pass:** exits 0 with no output (or only informational lines).
**Fail:** show the TypeScript errors and fix them before continuing.

### Step 6 — Build

```bash
npm run build
```

**Pass:** exits 0, and `dist/index.js` exists, is executable, and starts with
`#!/usr/bin/env node`. Check with:
```bash
head -1 dist/index.js && test -x dist/index.js && echo "executable: yes"
```

**Fail:** show the build error and fix it.

### Step 7 — Config file

Check whether `connector.config.json` exists:

```bash
test -f connector.config.json && echo "exists" || echo "missing"
```

If **missing**: generate it from the example, decoding the obfuscated
placeholder credential:
```bash
node -e "
const fs = require('fs');
const ex = JSON.parse(fs.readFileSync('connector.config.example.json', 'utf8'));
const config = {
  relayBaseUrl: ex.relayBaseUrl,
  connectorCredential: Buffer.from(ex._connectorCredentialB64, 'base64').toString('utf8'),
  projectDir: ex.projectDir,
  provider: ex.provider,
  inactivityCompact: ex.inactivityCompact,
};
fs.writeFileSync('connector.config.json', JSON.stringify(config, null, 2) + '\n');
console.log('connector.config.json written');
"
```

Then ask the user for the real Connector credential minted for this machine by
an operator — the placeholder above is a stand-in, and the relay rejects it.

Then confirm or adjust:
- `projectDir` — defaults to `""` which means the connector uses whatever directory
  it is launched from. Set an absolute path here to override. **The connector
  always runs with permissions bypassed, because nobody is at the machine to
  answer a permission prompt and the phone has no way to approve one, so a
  prompted Turn would hang. Point it only at a checkout the user is willing to
  let an agent modify without being asked.**
- `provider` — already set to `{"type":"anthropic"}`; change to the [Bedrock](#bedrock) or [Copilot](#copilot) shape if needed
- `inactivityCompact` — already set to `{"afterMinutes":30}`, so the connector submits its own
  `/compact` after 30 minutes with no real Command completing. Remove the field entirely to turn
  this off, or change `afterMinutes` (5 minutes minimum).

`permissionMode` is not a field any more. If an existing config still has one,
it is ignored and the connector warns at startup; remove it.

If **exists**: validate that none of the fields still contain `REPLACE_ME` or
`/path/to/`:
```bash
grep -E "REPLACE_ME|/path/to/" connector.config.json && echo "NEEDS EDITING" || echo "ok"
```

### Step 8 — Relay reachability

Extract `relayBaseUrl` from the config and hit `GET /` — this should return the
phone HTML without any auth:

```bash
RELAY=$(node -e "const c=JSON.parse(require('fs').readFileSync('connector.config.json','utf8')); process.stdout.write(c.relayBaseUrl)")
curl -sf "${RELAY}/" -o /dev/null -w "HTTP %{http_code}\n"
```

**Pass:** `HTTP 200`.
**Fail:** the relay is unreachable from this machine. Check the URL in the config, and
verify the stack is deployed (`aws cloudformation describe-stacks --stack-name <name>`).

### Step 9 — Relay auth smoke test (create + end a session)

This verifies the `connectorCredential` is correct and the relay's DynamoDB tables
are working, without starting the SDK or needing a phone.

Extract config values with node (works cross-platform, no jq required):

```bash
RELAY=$(node -p "JSON.parse(require('fs').readFileSync('connector.config.json','utf8')).relayBaseUrl")
CREDENTIAL=$(node -p "JSON.parse(require('fs').readFileSync('connector.config.json','utf8')).connectorCredential")
PROJECT=$(node -p "JSON.parse(require('fs').readFileSync('connector.config.json','utf8')).projectDir")
PROVIDER=$(node -p "JSON.parse(require('fs').readFileSync('connector.config.json','utf8')).provider.type")
```

Create a session and capture the full response (use `-s`, not `-sf`, so failures print the error body):

```bash
SESSION=$(curl -s -X POST "${RELAY}/sessions" \
  -H "content-type: application/json" \
  -H "X-Connector-Credential: ${CREDENTIAL}" \
  -d "{\"permission_mode\":\"default\",\"provider_type\":\"${PROVIDER}\",\"project_dir\":\"${PROJECT}\"}")
echo "${SESSION}"
```

Check the response contains `session_id` (not an error):

```bash
echo "${SESSION}" | node -p "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); 'session_id: ' + d.session_id + ', phone_url: ' + d.phone_url"
```

End the session to clean up:

```bash
SESSION_ID=$(echo "${SESSION}" | node -p "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).session_id")
BEARER=$(echo "${SESSION}" | node -p "JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')).secret")

curl -s -X POST "${RELAY}/sessions/${SESSION_ID}/end" \
  -H "Authorization: Bearer ${BEARER}" \
  -w "\nHTTP %{http_code}\n"
```

**Pass:** `echo "${SESSION}"` shows a JSON object with `session_id` and `phone_url`;
the end call returns `HTTP 200`.
**Fail:**
- Response is `{"error":"missing or invalid X-Connector-Credential header"}` (HTTP 401) →
  `connectorCredential` in the config is wrong. Ask the user for the correct value —
  it cannot be recovered after minting, since only its hash is ever stored; an
  operator has to mint a fresh one and hand it over again.
- Connection error or non-200 from step 8 → relay is down or URL is wrong.

### Step 10 — Global install (optional but recommended)

If the user wants `rc-agent` on their PATH:

```bash
npm install -g .
rc-agent help 2>&1 | head -3
```

**Pass:** `rc-agent` runs without "command not found".

### Step 11 — Start it and verify the round trip

```bash
rc-agent start
rc-agent status
```

**Pass:** `rc-agent start` prints a phone URL and QR code; `rc-agent status` then shows
`process running`, `session ... (alive)`, and a `relay sees` age under 15s.

**Fail:** read the log path `rc-agent status` prints and check it. `rc-agent start` also
prints the last 20 log lines when the connector fails to come up.

Confirm resume works, since it is what makes a background connector usable:

```bash
rc-agent stop && rc-agent start
```

**Pass:** the second `rc-agent start` prints the **same** session id and phone URL,
and the log says `Resumed session <id>`.

Leave it running, or `rc-agent stop` to park it — the session stays resumable either
way. Use `rc-agent stop --end` only to deliberately discard the conversation.

### Summary of pass criteria

All of the following must be true before reporting success:

- [ ] Node.js >= 22
- [ ] The provider's CLI on PATH: `claude` (anthropic) or `copilot` (copilot, unless using `COPILOT_GITHUB_TOKEN`)
- [ ] Claude CLI authenticated (anthropic), AWS credentials valid (bedrock), **or** Copilot signed in or `COPILOT_GITHUB_TOKEN` set (copilot)
- [ ] `npm install` succeeded
- [ ] `npm run typecheck` clean
- [ ] `npm run build` succeeded; `dist/index.js` is executable with shebang
- [ ] `connector.config.json` exists with no placeholder values
- [ ] `GET <relayBaseUrl>/` returns HTTP 200
- [ ] `POST /sessions` with correct connectorCredential returns a session JSON
- [ ] `POST /sessions/{id}/end` returns HTTP 200
- [ ] `rc-agent start` prints a phone URL; `rc-agent status` shows the process running and
      the session alive
- [ ] `rc-agent stop && rc-agent start` resumes the **same** session id

If any check fails, stop, fix it, and re-run that check before moving on.
Do not report the setup as complete until every box is checked.

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
