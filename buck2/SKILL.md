---
name: buck2
description: |
  Debugging and configuring Meta's buck2 build system — especially execution-platform routing and
  remote cache (REAPI / BuildBuddy) setup. Trigger on: "buck2", ".buckconfig", "execution platform",
  "buck2 remote cache", "BuildBuddy", "buck2 cache hits are 0%", "buck2 what-ran", or any task that
  needs to make a buck2 build talk to a remote cache/RE backend, or diagnose why it isn't.
---

# buck2

Hard-won lessons from actually getting (and failing to get, then getting) buck2
remote caching working against BuildBuddy. The concepts generalize to any REAPI
remote-cache backend (BuildBuddy, EngFlow, bazel-remote, etc.) — only the
`[buck2_re_client]` addresses/headers are BuildBuddy-specific.

## Two separate platform concepts — don't confuse them

- **Target platform** (`PlatformInfo`/`ConfigurationInfo`): what a target is
  *configured for* (cpu/os/etc constraints, used by `select()`).
- **Execution platform** (`ExecutionPlatformInfo`/`CommandExecutorConfig`):
  *where and how* an action actually runs (local vs remote, cache read/write).

`[build] execution_platforms` in `.buckconfig` sets the **execution** platform
list. It is necessary but **not sufficient** to route real compile actions
through a custom cache-enabled platform — see the gotcha below.

## The gotcha that actually mattered

`[build] execution_platforms = root//platforms:cache` alone will NOT route
toolchain-owned actions (e.g. `rustc rlib`, `rustc metadata`, `rustc link` —
i.e. basically all of a Rust build's real work) through your custom platform.
They'll keep showing up under `prelude//platforms:default` in
`buck2 log what-ran`, no matter how you set `execution_platforms` (file,
`-c build.execution_platforms=...`, even `-c <cell>//build.execution_platforms=...`
per-cell overrides — all had zero effect on this).

The actual second lever is `[parser] target_platform_detector_spec` in
`.buckconfig`. It typically looks like:

```
[parser]
  target_platform_detector_spec = target:root//...->prelude//platforms:default \
    target:prelude//...->prelude//platforms:default \
    target:toolchains//...->prelude//platforms:default
```

Toolchains (e.g. `system_rust_toolchain` from `@prelude//toolchains:rust.bzl`)
are themselves targets living in the `prelude` cell, so *their* target
platform — and therefore which execution platform ends up running the
compiler — is governed by this detector spec, independent of
`[build] execution_platforms`. Override **both** together:

```
-c "parser.target_platform_detector_spec=target:root//...->root//platforms:cache target:prelude//...->root//platforms:cache target:toolchains//...->root//platforms:cache"
-c build.execution_platforms=root//platforms:cache
```

Only once both are set do `rustc rlib`/`rustc link`/etc. actually show
`root//platforms:cache` in `buck2 log what-ran` instead of
`prelude//platforms:default`.

Symptom before the fix, evidence after: `buck2 log what-ran --recent 0 |
awk -F'\t' '{print $2, $3}' | sort | uniq -c` — look at which platform label
each real compile action (not just `deps`/`diag` helper actions) landed on.

## A custom execution platform, if the stock one won't do

The stock `prelude//platforms:defs.bzl` `execution_platform` rule is a fully
static Starlark rule (no `read_config()` calls) — there's no hidden buckconfig
flag to flip `remote_cache_enabled` on the existing default platform. If you
need cache-enabled execution, copy the rule and change the
`CommandExecutorConfig`:

```python
executor_config = CommandExecutorConfig(
    local_enabled = True,
    remote_enabled = False,      # keep True only if your toolchain is truly
                                  # hermetic (see below) — this is the actual
                                  # safety switch against remote *execution*.
    remote_cache_enabled = True,  # unset/None on the stock default == off
    allow_cache_uploads = True,
)
```

Register it via `[build] execution_platforms = root//platforms:<name>` (plus
the detector-spec override above), pointing at a `rule()` that returns
`DefaultInfo`, `ExecutionPlatformInfo`, `PlatformInfo`, and
`ExecutionPlatformRegistrationInfo` — mirror the stock rule's structure
exactly (constraints built from `host_configuration.cpu`/`.os`) so the
platform is otherwise configuration-identical to the default.

## Remote *cache* vs remote *execution* — pick cache-only if paths aren't hermetic

If the toolchain embeds machine-local absolute paths (custom `clang`/`ar`
paths, `-L` search paths into e.g. a Homebrew Cellar), remote **execution**
will fail outright on generic RE workers that don't have those exact paths.
Set `remote_enabled = False` and only enable `remote_cache_enabled` +
`allow_cache_uploads` — actions still execute locally, only cache read/write
goes over the network. This is safe and does not require a hermetic
toolchain.

`engine_address` in `[buck2_re_client]` is still required even in
cache-only mode — the RE client needs it to establish a session at all.
Omitting it causes an infinite `Failed to connect to RE, retrying... (No
engine address)` loop. The actual safety gate against remote execution is
`remote_enabled = False` on the execution platform, not omitting the address.

## Minimal BuildBuddy config

```
[buck2_re_client]
engine_address = remote.buildbuddy.io
action_cache_address = remote.buildbuddy.io
cas_address = remote.buildbuddy.io
http_headers = x-buildbuddy-api-key:$BUILDBUDDY_API_KEY
```

`$VAR` in `http_headers` is substituted from the **shell environment at
invocation time** — if the var isn't set, the build **hard-fails** (does not
silently fall back to local): `Error converting headers: Error substituting
'$VAR': environment variable not found`. Make sure whatever loads the env var
(direnv, etc.) is actually hooked into the shell before relying on this in
day-to-day use, not just in the terminal you tested it from.

## Verifying the server side directly, without a browser

```bash
brew install grpcurl   # or go install github.com/fullstorydev/grpcurl/cmd/grpcurl@latest
grpcurl -H "x-buildbuddy-api-key: $BUILDBUDDY_API_KEY" remote.buildbuddy.io:443 list
grpcurl -H "x-buildbuddy-api-key: $BUILDBUDDY_API_KEY" \
  -d '{"action_digest":{"hash":"00...0","size_bytes":1}}' \
  remote.buildbuddy.io:443 build.bazel.remote.execution.v2.ActionCache/GetActionResult
# NotFound (not an auth error) on a bogus digest == server reachable + auth OK.
```
This isolates "is the backend even working" from "is buck2 routing/uploading
correctly" without needing the BuildBuddy web dashboard at all.

## Testing methodology pitfalls (these produced false "0% hits" for hours)

1. **`buck2 killall` only clears the daemon's in-memory DICE graph — it does
   NOT touch `buck-out` on disk.** Rebuilding an unchanged target after
   `killall` alone can be a free no-op satisfied entirely from local disk
   state, never reaching the execution layer (local or remote) at all. To
   force a genuine cold build, `rm -rf buck-out` (or use a fresh
   `--isolation-dir`, but note isolation dirs each get their own `buck-out`
   subtree, not a shared one — check with `find buck-out -maxdepth 2 -type d`).

2. **Building a library target standalone (`buck2 build
   //third-party:some-crate`) may only run cheap metadata/diagnostic actions,
   not the real codegen (`rustc rlib`) action.** `buck2 log what-ran` won't
   show a compile action that never happened. Test against a real consumer
   (a binary that actually links the crate), or a full top-level build,
   to force real codegen.

3. **The execution platform's config hash is baked into every action's cache
   digest.** Two builds must use the *exact same* execution-platform config
   (same file state, same `-c` overrides — don't mix-and-match between runs)
   or a successful upload from run 1 can never match run 2's digest. Watch
   for this in `what-ran` output: `root//platforms:cache#<hash>` — if the
   hash suffix differs between "identical" runs, that's your bug, not the
   cache.

4. **`--upload-all-actions` forces raw CAS blob uploads for benchmarking/RE
   dispatch-readiness — it is not proof that ActionCache result entries
   (the thing a later build actually looks up) got written.** A `95%
   cached` reading can also just be buck2's own in-process failure
   memoization on a retried/racing build, not a real remote hit — check the
   `Commands: N (cached: X, ...)` breakdown and whether the build actually
   `BUILD FAILED` in the same output before trusting a "cached" number.

## The rigorous way to test for a real cache hit

Both passes below must use *identical* config (same `-c` flags, same file
state) and force a genuine cold build (`rm -rf buck-out` both times, real
top-level target that forces codegen+link, not a leaf library):

```bash
buck2 killall && rm -rf buck-out
time buck2 build //:some-real-target -c build.execution_platforms=root//platforms:cache \
  -c "parser.target_platform_detector_spec=...->root//platforms:cache ..."
# ^ necessarily local, populates the cache if allow_cache_uploads works

buck2 killall && rm -rf buck-out   # clean local state again, config unchanged
time buck2 build //:some-real-target -c build.execution_platforms=root//platforms:cache \
  -c "parser.target_platform_detector_spec=...->root//platforms:cache ..."
# ^ if this shows `cached: N > 0` and is dramatically faster, caching is real.
```

## If routing is fixed and hits are STILL 0%

Fixing the `target_platform_detector_spec` gotcha above is necessary but may
not be sufficient. After confirming via `what-ran` that every real compile
action is correctly landing on the cache platform, run the rigorous two-pass
test (same paragraph above) one more time. If it's *still* 0% hits on both
passes — same machine, same config, `buck-out` wiped clean between passes,
routing confirmed correct — that's no longer a config problem reachable from
buckconfig. It means either:

- `allow_cache_uploads` isn't actually writing ActionCache entries for
  locally-executed actions in your buck2 version (as opposed to
  `remote_enabled` actions, which write as a side effect of running on an RE
  worker) — `--write-to-cache-anyway` looked like it might be the fix for
  this but it's explicitly documented as requiring `--no-remote-cache`
  (i.e. it's for the RE-worker-execution case, not pure local exec), so it
  doesn't apply here.
- Or action digests aren't actually reproducible between two nominally
  identical local invocations (e.g. something machine/invocation-specific
  leaking into the command line or env that gets hashed).

Both require reading buck2's own source to confirm — not diagnosable purely
from the client CLI/config surface. Don't burn more time re-testing routing
once it's confirmed correct in `what-ran`; the remaining gap is a different,
deeper question.

## Useful diagnostic commands

- `buck2 log what-ran --recent 0` — every action from the last build, with
  its execution-platform label + config hash, and local command or RE digest.
- `buck2 audit config --cell <root|prelude|toolchains|none> <section>.<key>`
  — resolve a config key independently per cell; config set in the root
  cell's `.buckconfig`/`.buckconfig.local` does **not** automatically apply
  to other cells (prelude, toolchains, bundled external cells).
- `buck2 build --help | grep -i cache` — surfaces `--no-remote-cache`,
  `--write-to-cache-anyway` (RE-worker-side cache write when
  `--no-remote-cache` is set — not relevant to pure local execution),
  `--upload-all-actions` (forced CAS upload, see pitfall #4 above).
