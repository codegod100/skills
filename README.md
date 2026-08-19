# skills

Personal [Claude Code](https://claude.com/claude-code) skills — reusable,
version-controlled instructions + scripts that Claude loads on demand.

## Install

Symlink (or clone directly into) `~/.claude/skills/`:

```bash
git clone <this-repo-url> ~/code/skills
ln -s ~/code/skills/<skill-name> ~/.claude/skills/<skill-name>
```

## Skills

- **[atproto-login](atproto-login/)** — Generic AT Protocol (Bluesky
  ecosystem) OAuth login shim for CLI tools: resolves a handle/DID to its PDS
  and authorization server, runs the PKCE + DPoP + Pushed Authorization
  Request loopback-client flow, hands you a URL to open in a browser, and
  stores the resulting DPoP-bound credentials for making authenticated XRPC
  calls afterward. Pure Node.js, no dependencies.

- **[tangled-ci](tangled-ci/)** — Trigger Tangled Spindle CI pipelines from
  the CLI. Uses `atproto-login` credentials to call `sh.tangled.ci.triggerPipeline`
  on the repo's knot server — dispatch a named workflow at the current commit
  without a code push. Requires `atproto-login` to be installed alongside it.
