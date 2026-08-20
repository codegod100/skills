---
name: vit
description: |
  Work with VIT (v-it.org) — a collaboration platform for humans and coding agents to discover,
  evaluate, and share software capabilities on the ATProto network. Use when asked to browse or
  discover capabilities/skills on the VIT network, integrate a VIT capability into the current
  project, publish/ship a new capability to the network, install a VIT skill globally or
  per-project, follow a publisher, or scan the network for active publishers.
  Trigger on: "vit skim", "skim the vit network", "find capabilities on VIT", "remix a VIT
  capability", "ship this to VIT", "publish to VIT", "learn VIT skill", "install VIT skill",
  "follow on VIT", "vit init", "scan for VIT publishers", "add capability to VIT network".
  NOTE: Login and vet are human tasks — never run `vit login` or `vit vet` yourself; prompt
  the user to run them in their terminal.
---

# vit

[VIT](https://v-it.org) is a collaboration platform connecting humans and coding agents to
discover, evaluate, and share software capabilities. Built on ATProto (the Bluesky ecosystem's
protocol), it gives every capability a decentralized network identity.

## Prerequisites

- Node.js 20+
- VIT installed: `npm install -g vit`
- User logged in (human runs `vit login <handle.bsky.social>` in their terminal — agent must NOT do this)

## Task division

| Task | Who runs it |
|------|-------------|
| `vit login` / `vit vet` | **Human** (requires browser OAuth / sandbox UI) |
| `vit init`, `vit skim`, `vit remix`, `vit ship`, `vit learn`, `vit follow`, `vit scan` | **Agent** |

## Core workflow

VIT operates through four primary verbs:

1. **Skim** — browse available capabilities filtered by followed publishers
2. **Vet** — test in an isolated sandbox *(human task — prompt the user)*
3. **Remix** — adapt a vetted capability into the current project
4. **Ship** — publish a new or improved capability to the network

## Commands

### Discovery

```bash
# List available capabilities (projects + skills) from followed publishers
vit skim

# List available skills only
vit skim --skills

# Follow a publisher to see their capabilities
vit follow <handle.bsky.social>

# Discover active publishers on the network
vit scan
```

### Integration

```bash
# Initialise VIT in the current project (creates metadata / config)
vit init

# Remix (adapt) a capability from the network into the current project
vit remix

# Install a skill globally (agent-accessible everywhere)
vit learn <skill-name>

# Install a skill per-project only
vit learn <skill-name> --user
```

### Publishing

```bash
# Ship a new or improved capability to the network (requires Git)
vit ship
```

### Troubleshooting

```bash
# Re-login with verbose output (human runs this)
vit login <handle.bsky.social> -v

# Login on a remote machine (human runs this, opens a URL to paste in local browser)
vit login <handle.bsky.social> --remote

# App-password fallback if OAuth browser flow is blocked
vit login <handle.bsky.social> --app-password <password>
```

## Workflow when invoked as an agent

### Discovering and integrating a capability

1. Run `vit skim` (or `vit skim --skills`) to list what's available. Show the output to the user.
2. If the user wants to evaluate one, **tell them to run `vit vet <capability-name>` in their terminal** — do not run it yourself, as it opens an interactive sandbox UI.
3. Once the user confirms the capability is good, run `vit remix` to adapt it into the project.

### Installing a skill

```bash
# Global (available to the agent across all projects)
vit learn <skill-name>

# Project-local
vit learn <skill-name> --user
```

After installing, inform the user that the skill is now available and may need the agent to reload/restart to pick it up.

### Publishing a new capability

1. Ensure the project has been initialised: `vit init` (idempotent).
2. Run `vit ship` — it bundles the capability and publishes it to the user's ATProto network identity.
3. Print the output so the user can see the published capability's URL.

### Following publishers

```bash
vit follow jeremie.com    # example publisher
vit scan                  # surface more active publishers
```

## Notes

- VIT authenticates via the user's Bluesky account (ATProto OAuth); credentials are managed by the `vit` CLI itself, not by this skill.
- `vit ship` requires Git to be available (it uses commit history for provenance).
- Skills installed with `vit learn` land in `~/.claude/skills/` (or the project-local equivalent) and become available to the agent automatically.
