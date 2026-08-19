#!/usr/bin/env node
// tangled-ci: Trigger Tangled Spindle CI pipelines from the command line.
//
// Wraps atproto-login's credential store + DPoP machinery to call the
// sh.tangled.ci.triggerPipeline XRPC procedure on the repo's knot server.
//
// Usage:
//   node tangled-ci.mjs login <handle-or-did> [--profile NAME]
//   node tangled-ci.mjs trigger <workflow> [--owner <did>] [--sha <sha>] [--ref <ref>] [--host <url>] [--profile NAME]
//   node tangled-ci.mjs whoami [--profile NAME]
//   node tangled-ci.mjs list

import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the atproto-login lib relative to this skill's own directory.
// Works whether skills are symlinked or cloned directly.
const libPath = path.resolve(__dirname, '..', 'atproto-login', 'lib.mjs');
if (!fs.existsSync(libPath)) {
  console.error(
    `[tangled-ci] Cannot find atproto-login/lib.mjs at ${libPath}.\n` +
    `Make sure the atproto-login skill is installed in the same skills directory.`
  );
  process.exit(1);
}

const { loadProfile, saveProfile, dpopFetch, resolveIdentity } = await import(libPath);

// Also import the atproto-login CLI path so we can delegate login/whoami to it.
const loginCliPath = path.resolve(__dirname, '..', 'atproto-login', 'atproto-login.mjs');

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = args[key] ? [].concat(args[key], next) : next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function log(...a) {
  console.error('[tangled-ci]', ...a);
}

function currentGitSha() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function currentGitRef() {
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();
    if (branch && branch !== 'HEAD') return `refs/heads/${branch}`;
  } catch {}
  return 'refs/heads/main';
}

// Resolve the knot server URL for a DID by fetching its DID document.
async function resolveKnotFromDid(did) {
  const url = did.startsWith('did:plc:')
    ? `https://plc.directory/${encodeURIComponent(did)}`
    : null;
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const doc = await res.json();
    const svc = doc.service?.find(s => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer');
    return svc?.serviceEndpoint?.replace(/\/$/, '') ?? null;
  } catch {
    return null;
  }
}

// Resolve handle → DID via the atproto-login lib, then resolve knot URL.
async function resolveKnotFromHandle(handle) {
  const { resolveIdentity } = await import(libPath);
  const { did } = await resolveIdentity(handle, { skipHandleVerification: true });
  const knotUrl = await resolveKnotFromDid(did);
  return { did, knotUrl };
}

async function authedCall(profileName, url, body) {
  const data = loadProfile(profileName);
  if (!data) {
    console.error(`No saved credentials for profile "${profileName}". Run:\n  node tangled-ci.mjs login <handle> --profile ${profileName}`);
    process.exit(1);
  }

  let res = await dpopFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    dpopKeys: data.dpopKeys,
    nonces: data.nonces,
    accessToken: data.accessToken,
  });

  // One automatic refresh on 401
  if (res.status === 401 && data.refreshToken) {
    log('Access token expired, refreshing...');
    const tokenBody = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: data.refreshToken,
      client_id: data.clientId,
    });
    const refreshRes = await dpopFetch(data.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody.toString(),
      dpopKeys: data.dpopKeys,
      nonces: data.nonces,
    });
    const refreshJson = await refreshRes.json();
    if (!refreshRes.ok) throw new Error(`Refresh failed: ${JSON.stringify(refreshJson)}`);
    data.accessToken = refreshJson.access_token;
    if (refreshJson.refresh_token) data.refreshToken = refreshJson.refresh_token;
    saveProfile(profileName, data);
    res = await dpopFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      dpopKeys: data.dpopKeys,
      nonces: data.nonces,
      accessToken: data.accessToken,
    });
  }

  return res;
}

// --- commands ----------------------------------------------------------------

// login: delegate directly to atproto-login CLI (it handles the full OAuth dance)
async function cmdLogin(args) {
  const passArgs = process.argv.slice(3); // everything after 'login'
  const r = spawnSync('node', [loginCliPath, 'login', ...passArgs], { stdio: 'inherit' });
  process.exit(r.status ?? 0);
}

async function cmdWhoami(args) {
  const passArgs = process.argv.slice(3);
  const r = spawnSync('node', [loginCliPath, 'whoami', ...passArgs], { stdio: 'inherit' });
  process.exit(r.status ?? 0);
}

function cmdList() {
  const passArgs = process.argv.slice(3);
  const r = spawnSync('node', [loginCliPath, 'list', ...passArgs], { stdio: 'inherit' });
  process.exit(r.status ?? 0);
}

async function cmdTrigger(args) {
  const workflow = args._[1];
  if (!workflow) {
    console.error('Usage: tangled-ci.mjs trigger <workflow-name> [--owner <did>] [--sha <sha>] [--ref <ref>] [--host <url>] [--profile NAME]');
    process.exit(1);
  }

  const profile = args.profile || 'default';
  const data = loadProfile(profile);
  if (!data) {
    console.error(`No saved credentials for profile "${profile}". Run:\n  node tangled-ci.mjs login <handle> --profile ${profile}`);
    process.exit(1);
  }

  // Resolve target SHA
  const sha = args.sha ?? currentGitSha();
  if (!sha || sha.length !== 40) {
    console.error('Could not determine a 40-char SHA. Pass --sha <sha> explicitly.');
    process.exit(1);
  }

  // Resolve git ref for display (optional)
  const ref = args.ref ?? currentGitRef();

  // Resolve knot host: --host flag > profile's PDS > resolve from owner DID
  let host = args.host ?? data.pds;
  if (!host) {
    console.error('Cannot determine knot server. Pass --host <url> or set up the profile with a PDS.');
    process.exit(1);
  }

  // Resolve repo DID: --owner flag > profile DID (the authenticated user)
  // In Tangled, each git repo has its own DID distinct from the owner's DID.
  // Use --owner to supply the repo's own DID; the authenticated user must have
  // write access to that repo. If not passed, falls back to the profile's own DID
  // (works when the authenticated user IS the repo owner and the repo DID == owner DID,
  // or when the knot resolves the target from the auth token alone).
  const ownerDid = args.owner ?? data.did;

  const endpoint = `${host.replace(/\/$/, '')}/xrpc/sh.tangled.ci.triggerPipeline`;

  const payload = {
    repo: ownerDid,
    trigger: {
      $type: 'sh.tangled.ci.trigger#manual',
      sha,
      ref,
    },
    workflows: [workflow],
  };

  log(`Triggering workflow "${workflow}" on ${host}`);
  log(`  repo: ${ownerDid}`);
  log(`  sha:  ${sha}`);
  log(`  ref:  ${ref}`);

  const res = await authedCall(profile, endpoint, payload);
  const json = await res.json().catch(() => null);

  if (!res.ok) {
    console.error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
    process.exit(1);
  }

  console.log(`\nPipeline queued: ${json?.pipeline ?? '(no AT-URI returned)'}`);
  if (json?.pipeline) {
    const pipelineId = json.pipeline.split('/').pop();
    console.log(`  View at: https://tangled.org/${data.handle ?? ownerDid}/sleek/pipelines/${pipelineId}`);
  }
}

// --- main --------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  switch (cmd) {
    case 'login':   return cmdLogin(args);
    case 'whoami':  return cmdWhoami(args);
    case 'list':    return cmdList();
    case 'trigger': return cmdTrigger(args);
    default:
      console.error(`tangled-ci: Trigger Tangled Spindle CI pipelines from the CLI.

Commands:
  login <handle-or-did>   Log in via ATProto OAuth (opens a browser URL)
  trigger <workflow>      Trigger a named workflow on the current commit
  whoami                  Verify stored credentials
  list                    List saved profiles

Options for 'trigger':
  --owner <did>    Repository DID (default: authenticated user's own DID)
  --sha <sha>      Commit SHA to build (default: git rev-parse HEAD)
  --ref <ref>      Ref for display, e.g. refs/heads/main (default: current branch)
  --host <url>     Knot server base URL (default: profile's PDS)
  --profile NAME   Credential profile name (default: "default")

Example (sleek trigger-build):
  node tangled-ci.mjs login nandi.uk --profile tangled
  node tangled-ci.mjs trigger trigger-build --profile tangled`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('[tangled-ci] Error:', err.message);
  process.exit(1);
});
