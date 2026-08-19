---
name: tangled-ci
description: |
  Trigger Tangled Spindle CI pipelines from the CLI via ATProto OAuth. Use when asked to manually
  trigger a Tangled workflow / CI run, check build status on Tangled, or dispatch a named workflow
  in a Tangled repository without pushing code. Requires the atproto-login skill to be installed
  in the same skills directory. Trigger on: "trigger [Tangled] workflow", "run trigger-build on
  tangled", "manually trigger CI on Tangled", "dispatch Tangled pipeline", "fire Tangled build".
---

# tangled-ci

CLI tool for dispatching Tangled Spindle CI pipelines via ATProto OAuth.

**What it does:** authenticates with the user's Tangled account (delegating to `atproto-login`
for the OAuth loopback flow), then calls `sh.tangled.ci.triggerPipeline` on the repo's knot
server to queue a named workflow run at the current commit — no code push required.

**Requires:** the `atproto-login` skill installed alongside this one (same parent directory).

## Files

- `tangled-ci.mjs` — the CLI. Imports DPoP/credential helpers from `../atproto-login/lib.mjs`.

## Usage

```bash
SKILLS=~/.claude/skills  # or wherever your skills live

# 1. Log in once (opens a browser URL — print it to the user and wait)
node $SKILLS/tangled-ci/tangled-ci.mjs login nandi.uk --profile tangled

# 2. Trigger a workflow (from inside the repo, so HEAD SHA is picked up automatically)
node $SKILLS/tangled-ci/tangled-ci.mjs trigger trigger-build --profile tangled

# Explicit SHA / ref / host
node $SKILLS/tangled-ci/tangled-ci.mjs trigger trigger-build \
  --profile tangled \
  --sha abc123...  \
  --ref refs/heads/main \
  --host https://knot1.tangled.sh

# Verify you're still logged in
node $SKILLS/tangled-ci/tangled-ci.mjs whoami --profile tangled
```

## Workflow when invoked as an agent

1. If no `--profile tangled` credentials exist yet, run `login nandi.uk --profile tangled` and
   **print the URL to the user — stop and wait** for them to complete the browser OAuth flow.
   The command blocks for up to 5 minutes for the loopback redirect.
2. Once logged in, run `trigger <workflow-name> --profile tangled` from inside the target repo
   directory (so `git rev-parse HEAD` picks up the right SHA automatically).
3. The command prints a pipeline AT-URI on success. The pipeline runs on Tangled's Spindle CI
   with access to repo secrets (e.g. `TANGLED_WEBHOOK_SECRET`).

## Protocol details

- XRPC procedure: **`sh.tangled.ci.triggerPipeline`** (POST, auth required)
- Knot server for `nandi.uk` / `did:plc:eimwo4adqwppiiweleayixez`: `https://knot1.tangled.sh`
- Auth: DPoP-bound ATProto access token from the `atproto-login` profile store
  (`~/.atproto-login-shim/<profile>.json`)
- Input schema (manual trigger):
  ```json
  {
    "repo": "<repo-DID-or-owner-DID>",
    "trigger": {
      "$type": "sh.tangled.ci.trigger#manual",
      "sha": "<40-char-commit-sha>",
      "ref": "refs/heads/main"
    },
    "workflows": ["<workflow-name>"]
  }
  ```
- If the knot returns 404 for the `repo` DID, pass the repository's own DID via `--owner`.
  You can look it up via: `atproto-login call sh.tangled.repo.getRepos --profile tangled`
  or check the Tangled web UI's repo settings page.

## Credential store

Credentials are shared with `atproto-login` — both read from
`~/.atproto-login-shim/<profile>.json`. Log in once, use from either tool.
