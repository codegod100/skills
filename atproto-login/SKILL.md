---
name: atproto-login
description: |
  Generic AT Protocol (Bluesky ecosystem) OAuth login shim for CLI tools and scripts. Use when a
  task needs to authenticate a user against their own PDS via AT Protocol OAuth — give the user a
  login URL to open in their browser, then use the DPoP-bound credentials that come back to make
  authenticated XRPC calls. Trigger on: "atproto login", "bluesky login", "log into my PDS",
  "authenticate with AT Protocol", "did:plc / did:web login", or any app whose auth is described as
  "AT Protocol OAuth" / "atproto OAuth". Not for apps that only need an atproto "app password" (that's
  simpler and doesn't need this flow) and not for SSH-key-based git auth (e.g. tangled.sh repo pushes
  use registered SSH keys, not OAuth bearer tokens — this skill can still log you into such an app's
  own atproto-backed account if the app exposes ordinary XRPC endpoints).
---

# atproto-login

A from-scratch implementation of the AT Protocol OAuth "loopback client" flow
(the pattern the [atproto OAuth spec](https://atproto.com/specs/oauth) defines
specifically for native/CLI apps that can't pre-register a `client_id`). No
npm dependencies — pure Node.js (`crypto`, `http`, `dns`, `fetch`).

**What it does:** resolve a handle or DID to its PDS and OAuth authorization
server, run PKCE + DPoP + Pushed Authorization Request, hand you a URL to open
in a browser, catch the redirect on a local loopback server, exchange the code
for DPoP-bound tokens, and store everything so you can make authenticated XRPC
calls afterward (with automatic token refresh).

**What it is not:** it doesn't know anything about a specific target app's
custom API surface (e.g. it can't guess tangled.sh's lexicons for registering
an SSH key). It gets you a valid, DPoP-bound `access_token` for the user's own
PDS (or another resource server, via `--host`) — what you do with that is
app-specific. If the app you're bridging to only needs an "app password"
(legacy `com.atproto.server.createSession`), that's simpler than this and
doesn't need OAuth at all — ask the user to generate one at
`https://bsky.app/settings/app-passwords` instead.

## Files

- `lib.mjs` — identity resolution (handle/DID → DID doc → PDS → AS metadata),
  PKCE, DPoP key generation + proof signing (ES256, raw IEEE P1363 signatures
  via Node's `dsaEncoding: 'ieee-p1363'`), and `dpopFetch()`, a fetch wrapper
  that transparently retries once on a `DPoP-Nonce` challenge.
- `atproto-login.mjs` — the CLI: `login`, `whoami`, `refresh`, `call`,
  `logout`, `list`.

Credentials are stored per-profile at `~/.atproto-login-shim/<profile>.json`
(mode 0600): DID, PDS, authorization server, the DPoP keypair, access/refresh
tokens, and per-origin DPoP nonces.

## Usage

```bash
# Log in (opens nothing itself — prints a URL for the human to open)
node ~/.claude/skills/atproto-login/atproto-login.mjs login alice.bsky.social --profile alice

# Verify it worked
node ~/.claude/skills/atproto-login/atproto-login.mjs whoami --profile alice

# Make an authenticated XRPC call against the user's own PDS
node ~/.claude/skills/atproto-login/atproto-login.mjs call com.atproto.repo.listRecords \
  --profile alice --get repo=alice.bsky.social --get collection=app.bsky.feed.post

# Call a *different* resource server (e.g. an app's own AS/API) that this
# same DID has a session with
node ~/.claude/skills/atproto-login/atproto-login.mjs call com.example.someMethod \
  --profile alice --host https://api.example.com

node ~/.claude/skills/atproto-login/atproto-login.mjs refresh --profile alice
node ~/.claude/skills/atproto-login/atproto-login.mjs logout --profile alice
node ~/.claude/skills/atproto-login/atproto-login.mjs list
```

## Workflow when invoked as an agent

1. Run `login <handle-or-did>` with a `--profile` name scoped to the task
   (e.g. the target app's name) so multiple logins don't collide.
2. **Print the URL it outputs to the user and stop — do not try to open a
   browser yourself or guess at completing the flow.** The user must
   authenticate interactively (username/password/2FA/consent all happen on
   their PDS's own login page). The command blocks for up to 5 minutes
   waiting for the browser redirect to hit the local loopback server.
3. Once it reports "Logged in as ...", use `whoami` to confirm, then `call`
   for whatever XRPC method the actual task needs.
4. If a call fails with 401, `atproto-login.mjs call`/`whoami` already
   auto-refresh once and retry — a persistent 401 means the token was
   revoked or the scope granted (`atproto transition:generic` by default) is
   insufficient for that method; re-run `login` with `--scope` widened if the
   target app documents a specific scope it needs.

## Scope

Default requested scope is `atproto transition:generic` — `atproto` alone
only proves identity/DID ownership; `transition:generic` is the broad legacy
compatibility scope most PDS-hosted read/write XRPC methods still expect as
of 2026. Override with `--scope "..."` if the target app's docs specify
something narrower/different.

## Protocol notes (for maintaining this skill)

- `client_id` for loopback clients must be exactly `http://localhost` origin
  (empty path) with `redirect_uri` and `scope` as query params — NOT
  `127.0.0.1` as the origin. The actual `redirect_uri` used for the local
  listener IS `127.0.0.1:<ephemeral port>`; the AS ignores the port when
  matching it, so any free port works without pre-registration.
- PAR (Pushed Authorization Request) is mandatory; the authorize-endpoint
  redirect only carries `client_id` + `request_uri`.
- DPoP is mandatory on every request to both the authorization server and
  resource server, signed with the same ES256 keypair for the life of the
  session, with a server-issued nonce that rotates — `dpopFetch()` handles
  the "missing/stale nonce → 400/401 → retry with new nonce" dance
  automatically and this has been verified against the live `bsky.social`
  authorization server (a real PAR call round-trips a `request_uri`).
- Verify `sub` in the token response matches the DID resolved at the start,
  and that `scope` in the response actually contains `atproto` — both are
  checked in `cmdLogin`.
- Handle resolution tries, in order: DNS TXT `_atproto.<handle>`, HTTPS
  `.well-known/atproto-did`, then the public Bluesky
  `com.atproto.identity.resolveHandle` API as a last-resort fallback (covers
  `*.bsky.social` handles, which don't serve their own DNS/HTTP well-known).
- By default, handle→DID resolution is bidirectionally verified (the DID
  doc's `alsoKnownAs` must list `at://<handle>`) per spec, to resist
  spoofing; pass a DID directly (skips this check entirely) or
  `--skip-handle-verification` to bypass if needed.
