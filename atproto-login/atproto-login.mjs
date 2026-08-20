#!/usr/bin/env node
// atproto-login: a generic AT Protocol OAuth "loopback client" shim for CLI
// tools. Hands you a login URL, completes the OAuth+PKCE+DPoP dance against
// the account's own PDS, and stores DPoP-bound credentials you can reuse to
// call any XRPC endpoint. See SKILL.md for the full explanation.
//
// Usage:
//   node atproto-login.mjs login <handle-or-did> [--profile NAME] [--scope "atproto transition:generic"]
//   node atproto-login.mjs whoami [--profile NAME]
//   node atproto-login.mjs refresh [--profile NAME]
//   node atproto-login.mjs call <nsid> [--profile NAME] [--get k=v ...] [--input '<json>'] [--host pds|auth|<url>]
//   node atproto-login.mjs logout [--profile NAME]
//   node atproto-login.mjs list

import crypto from 'node:crypto';
import http from 'node:http';
import {
  STORE_DIR,
  loadProfile,
  saveProfile,
  deleteProfile,
  makePkce,
  generateDpopKeyPair,
  dpopFetch,
  resolveIdentity,
} from './lib.mjs';
import fs from 'node:fs';

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
  console.error('[atproto-login]', ...a);
}

async function waitForCallback(server, expectedState, timeoutMs, { clientMetadataJson } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('Timed out waiting for the OAuth callback.'));
    }, timeoutMs);

    server.on('request', (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');

      // Serve the client metadata document when running in cloud/public-URL mode.
      if (clientMetadataJson && (url.pathname === '/client-metadata.json' || url.pathname === '/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(clientMetadataJson);
        return;
      }

      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const iss = url.searchParams.get('iss');
      const error = url.searchParams.get('error');

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(
        error
          ? `<html><body><h3>Login failed: ${error}</h3>You can close this tab.</body></html>`
          : `<html><body><h3>Logged in ✓</h3>You can close this tab and return to the terminal.</body></html>`,
      );

      clearTimeout(timer);
      server.close();

      if (error) {
        reject(new Error(`Authorization server returned error: ${error}`));
        return;
      }
      if (state !== expectedState) {
        reject(new Error('State mismatch on OAuth callback — possible CSRF, aborting.'));
        return;
      }
      resolve({ code, iss });
    });
  });
}

async function cmdLogin(args) {
  const identity = args._[1];
  if (!identity) {
    console.error('Usage: atproto-login.mjs login <handle-or-did> [--profile NAME] [--scope "..."] [--paste-callback] [--public-url <url> --port <n>]');
    process.exit(1);
  }
  const profile = args.profile || 'default';
  const scope = args.scope || 'atproto transition:generic';
  const timeoutMs = Number(args.timeout || 300_000);

  // --paste-callback: OOB flow for cloud environments where the loopback server isn't reachable
  // from the user's browser. Uses a fixed loopback redirect_uri (no server needed — the browser
  // may show ERR_CONNECTION_REFUSED but the URL with the auth code is visible in the address bar).
  // The user copies that URL and pastes it at the prompt.
  const pasteCallback = !!args['paste-callback'];

  // Cloud mode: --public-url <https://…> --port <n>
  // The callback server is exposed via a public URL (e.g. Blocks-registered port).
  // The ATProto AS fetches the client metadata document from <public-url>/client-metadata.json,
  // so the server also serves that endpoint. The client_id IS the metadata URL per ATProto OAuth.
  //
  // Loopback mode (default): ephemeral port on 127.0.0.1, loopback client_id trick.
  const publicUrl = args['public-url'] ? args['public-url'].replace(/\/$/, '') : null;

  let server, listenPort, clientIdStr, redirectUri, clientMetadataJson;

  if (pasteCallback) {
    // OOB mode: no server, fixed loopback port just for the redirect_uri shape.
    const fixedPort = Number(args.port || 8889);
    redirectUri = `http://127.0.0.1:${fixedPort}/callback`;
    const clientIdUrl = new URL('http://localhost/');
    clientIdUrl.searchParams.set('redirect_uri', redirectUri);
    clientIdUrl.searchParams.set('scope', scope);
    clientIdStr = clientIdUrl.toString();
    log(`OOB mode: redirect_uri=${redirectUri} (no local server — you will paste the callback URL)`);
  } else if (publicUrl) {
    const fixedPort = Number(args.port || 8889);
    server = http.createServer();
    await new Promise((resolve) => server.listen(fixedPort, '0.0.0.0', resolve));
    listenPort = server.address().port;
    redirectUri = `${publicUrl}/callback`;
    clientIdStr = `${publicUrl}/client-metadata.json`;
    clientMetadataJson = JSON.stringify({
      client_id: clientIdStr,
      client_uri: publicUrl,
      redirect_uris: [redirectUri],
      scope,
      dpop_bound_access_tokens: true,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      application_type: 'web',
    });
    log(`Cloud mode: listening on 0.0.0.0:${listenPort}, public URL: ${publicUrl}`);
  } else {
    server = http.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    listenPort = server.address().port;
    redirectUri = `http://127.0.0.1:${listenPort}/callback`;
    const clientIdUrl = new URL('http://localhost/');
    clientIdUrl.searchParams.set('redirect_uri', redirectUri);
    clientIdUrl.searchParams.set('scope', scope);
    clientIdStr = clientIdUrl.toString();
  }

  log(`Resolving identity for ${identity}...`);
  const { did, pds, authServer, asMeta } = await resolveIdentity(identity, {
    skipHandleVerification: !!args['skip-handle-verification'],
  });
  log(`DID: ${did}`);
  log(`PDS: ${pds}`);
  log(`Authorization server: ${authServer}`);

  const { codeVerifier, codeChallenge } = makePkce();
  const dpopKeys = generateDpopKeyPair();
  const nonces = {};
  const state = crypto.randomBytes(16).toString('base64url');

  // 2. Pushed Authorization Request
  const parBody = new URLSearchParams({
    response_type: 'code',
    client_id: clientIdStr,
    redirect_uri: redirectUri,
    scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  if (!identity.startsWith('did:')) parBody.set('login_hint', identity);

  const parRes = await dpopFetch(asMeta.pushed_authorization_request_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: parBody.toString(),
    dpopKeys,
    nonces,
  });
  if (!parRes.ok) {
    server?.close();
    throw new Error(`PAR request failed: HTTP ${parRes.status} ${await parRes.text()}`);
  }
  const { request_uri } = await parRes.json();

  // 3. Print the login URL for the human to open.
  const authorizeUrl = new URL(asMeta.authorization_endpoint);
  authorizeUrl.searchParams.set('client_id', clientIdStr);
  authorizeUrl.searchParams.set('request_uri', request_uri);

  console.log('');
  console.log('Open this URL to log in (waiting up to ' + Math.round(timeoutMs / 1000) + 's):');
  console.log('');
  console.log('  ' + authorizeUrl.toString());
  console.log('');

  // 4. Complete the auth dance (callback or OOB save-state-and-exit).
  if (pasteCallback) {
    // Save pending auth state so `complete-login` can finish the exchange later.
    const pendingPath = `${STORE_DIR}/${profile}.pending.json`;
    fs.mkdirSync(STORE_DIR, { recursive: true });
    fs.writeFileSync(pendingPath, JSON.stringify({
      did, pds, authServer,
      tokenEndpoint: asMeta.token_endpoint,
      revocationEndpoint: asMeta.revocation_endpoint,
      issuer: asMeta.issuer,
      clientId: clientIdStr,
      redirectUri,
      scope,
      codeVerifier,
      dpopKeys,
      nonces,
      state,
    }, null, 2), { mode: 0o600 });

    console.log('After you authenticate, your browser will be redirected to a URL starting with:');
    console.log(`  ${redirectUri}?code=...`);
    console.log('');
    console.log('The page may show ERR_CONNECTION_REFUSED — that is expected (nothing is listening locally).');
    console.log('Copy the full URL from your browser address bar, then run:');
    console.log('');
    console.log(`  node atproto-login.mjs complete-login "<pasted-url>" --profile ${profile}`);
    console.log('');
    return;
  }

  let code, iss;
  ({ code, iss } = await waitForCallback(server, state, timeoutMs, { clientMetadataJson }));
  if (iss && asMeta.issuer && iss !== asMeta.issuer) {
    throw new Error(`Issuer mismatch on callback: expected ${asMeta.issuer}, got ${iss}`);
  }

  // 5. Exchange the authorization code for DPoP-bound tokens.
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
    client_id: clientIdStr,
  });
  const tokenRes = await dpopFetch(asMeta.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody.toString(),
    dpopKeys,
    nonces,
  });
  const tokenJson = await tokenRes.json();
  if (!tokenRes.ok) {
    throw new Error(`Token exchange failed: HTTP ${tokenRes.status} ${JSON.stringify(tokenJson)}`);
  }
  if (!tokenJson.scope || !tokenJson.scope.split(' ').includes('atproto')) {
    throw new Error(`Token response missing required "atproto" scope: ${JSON.stringify(tokenJson.scope)}`);
  }
  if (tokenJson.sub && tokenJson.sub !== did) {
    throw new Error(`Token sub (${tokenJson.sub}) does not match resolved DID (${did})`);
  }

  saveProfile(profile, {
    did,
    handle: identity.startsWith('did:') ? undefined : identity,
    pds,
    authServer,
    tokenEndpoint: asMeta.token_endpoint,
    revocationEndpoint: asMeta.revocation_endpoint,
    clientId: clientIdStr,
    redirectUri,
    scope: tokenJson.scope,
    dpopKeys,
    nonces,
    accessToken: tokenJson.access_token,
    refreshToken: tokenJson.refresh_token,
    tokenType: tokenJson.token_type,
    obtainedAt: Date.now(),
    expiresIn: tokenJson.expires_in || null,
  });

  log(`Saved credentials to ${STORE_DIR}/${profile}.json`);
  console.log(`\nLogged in as ${identity.startsWith('did:') ? did : identity} (${did})`);
}

async function refreshTokens(profile, data) {
  const tokenBody = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: data.refreshToken,
    client_id: data.clientId,
  });
  const res = await dpopFetch(data.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody.toString(),
    dpopKeys: data.dpopKeys,
    nonces: data.nonces,
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Refresh failed: HTTP ${res.status} ${JSON.stringify(json)}`);
  }
  data.accessToken = json.access_token;
  if (json.refresh_token) data.refreshToken = json.refresh_token; // refresh tokens rotate
  data.tokenType = json.token_type;
  data.obtainedAt = Date.now();
  data.expiresIn = json.expires_in || null;
  saveProfile(profile, data);
  return data;
}

function requireProfile(profileName) {
  const data = loadProfile(profileName);
  if (!data) {
    console.error(`No saved credentials for profile "${profileName}". Run: atproto-login.mjs login <handle> --profile ${profileName}`);
    process.exit(1);
  }
  return data;
}

async function authedFetch(profile, data, url, opts = {}) {
  let res = await dpopFetch(url, { ...opts, dpopKeys: data.dpopKeys, nonces: data.nonces, accessToken: data.accessToken });
  if (res.status === 401) {
    log('Access token expired/rejected, refreshing...');
    data = await refreshTokens(profile, data);
    res = await dpopFetch(url, { ...opts, dpopKeys: data.dpopKeys, nonces: data.nonces, accessToken: data.accessToken });
  }
  return res;
}

async function cmdWhoami(args) {
  const profile = args.profile || 'default';
  const data = requireProfile(profile);
  const url = new URL('/xrpc/com.atproto.server.getSession', data.pds);
  const res = await authedFetch(profile, data, url.toString(), { method: 'GET' });
  const json = await res.json();
  if (!res.ok) {
    console.error(`HTTP ${res.status}`, json);
    process.exit(1);
  }
  console.log(JSON.stringify(json, null, 2));
}

async function cmdRefresh(args) {
  const profile = args.profile || 'default';
  const data = requireProfile(profile);
  await refreshTokens(profile, data);
  console.log(`Refreshed tokens for profile "${profile}".`);
}

async function cmdCall(args) {
  const nsid = args._[1];
  if (!nsid) {
    console.error('Usage: atproto-login.mjs call <nsid> [--profile NAME] [--get k=v ...] [--input \'<json>\'] [--host pds|auth|<url>]');
    process.exit(1);
  }
  const profile = args.profile || 'default';
  const data = requireProfile(profile);

  let base = data.pds;
  if (args.host === 'auth') base = data.authServer;
  else if (args.host && args.host !== 'pds') base = args.host;

  const url = new URL(`/xrpc/${nsid}`, base);
  const getParams = [].concat(args.get || []);
  for (const kv of getParams) {
    const idx = kv.indexOf('=');
    if (idx === -1) continue;
    url.searchParams.append(kv.slice(0, idx), kv.slice(idx + 1));
  }

  const opts = { method: args.input ? 'POST' : 'GET' };
  if (args.input) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = args.input;
  }

  const res = await authedFetch(profile, data, url.toString(), opts);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) {
    console.error(`HTTP ${res.status}`);
    console.error(typeof json === 'string' ? json : JSON.stringify(json, null, 2));
    process.exit(1);
  }
  console.log(typeof json === 'string' ? json : JSON.stringify(json, null, 2));
}

async function cmdCompleteLogin(args) {
  const callbackUrl = args._[1];
  if (!callbackUrl) {
    console.error('Usage: atproto-login.mjs complete-login <callback-url> [--profile NAME]');
    console.error('  Finish an OOB login started with: atproto-login.mjs login ... --paste-callback');
    process.exit(1);
  }
  const profile = args.profile || 'default';
  const pendingPath = `${STORE_DIR}/${profile}.pending.json`;
  if (!fs.existsSync(pendingPath)) {
    console.error(`No pending login for profile "${profile}". Run: atproto-login.mjs login <handle> --paste-callback --profile ${profile}`);
    process.exit(1);
  }
  const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));

  const cbUrl = new URL(callbackUrl);
  const code = cbUrl.searchParams.get('code');
  const returnedState = cbUrl.searchParams.get('state');
  const iss = cbUrl.searchParams.get('iss');
  const error = cbUrl.searchParams.get('error');

  if (error) throw new Error(`Authorization server returned error: ${error}`);
  if (returnedState !== pending.state) throw new Error('State mismatch — possible CSRF, aborting.');
  if (!code) throw new Error('No code parameter found in the callback URL.');
  if (iss && pending.issuer && iss !== pending.issuer) {
    throw new Error(`Issuer mismatch: expected ${pending.issuer}, got ${iss}`);
  }

  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: pending.redirectUri,
    code_verifier: pending.codeVerifier,
    client_id: pending.clientId,
  });
  const tokenRes = await dpopFetch(pending.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenBody.toString(),
    dpopKeys: pending.dpopKeys,
    nonces: pending.nonces,
  });
  const tokenJson = await tokenRes.json();
  if (!tokenRes.ok) {
    throw new Error(`Token exchange failed: HTTP ${tokenRes.status} ${JSON.stringify(tokenJson)}`);
  }
  if (!tokenJson.scope || !tokenJson.scope.split(' ').includes('atproto')) {
    throw new Error(`Token response missing required "atproto" scope: ${JSON.stringify(tokenJson.scope)}`);
  }
  if (tokenJson.sub && tokenJson.sub !== pending.did) {
    throw new Error(`Token sub (${tokenJson.sub}) does not match expected DID (${pending.did})`);
  }

  saveProfile(profile, {
    did: pending.did,
    pds: pending.pds,
    authServer: pending.authServer,
    tokenEndpoint: pending.tokenEndpoint,
    revocationEndpoint: pending.revocationEndpoint,
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    scope: tokenJson.scope,
    dpopKeys: pending.dpopKeys,
    nonces: pending.nonces,
    accessToken: tokenJson.access_token,
    refreshToken: tokenJson.refresh_token,
    tokenType: tokenJson.token_type,
    obtainedAt: Date.now(),
    expiresIn: tokenJson.expires_in || null,
  });

  fs.unlinkSync(pendingPath);
  log(`Saved credentials to ${STORE_DIR}/${profile}.json`);
  console.log(`\nLogged in as ${pending.did}`);
}

function cmdLogout(args) {
  const profile = args.profile || 'default';
  deleteProfile(profile);
  console.log(`Removed credentials for profile "${profile}".`);
}

function cmdList() {
  if (!fs.existsSync(STORE_DIR)) {
    console.log('(no profiles yet)');
    return;
  }
  const files = fs.readdirSync(STORE_DIR).filter((f) => f.endsWith('.json'));
  if (files.length === 0) {
    console.log('(no profiles yet)');
    return;
  }
  for (const f of files) {
    const profile = f.replace(/\.json$/, '');
    const data = loadProfile(profile);
    console.log(`${profile}\t${data.did}${data.handle ? '\t' + data.handle : ''}\t${data.pds}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  switch (cmd) {
    case 'login':
      return cmdLogin(args);
    case 'whoami':
      return cmdWhoami(args);
    case 'refresh':
      return cmdRefresh(args);
    case 'call':
      return cmdCall(args);
    case 'complete-login':
      return cmdCompleteLogin(args);
    case 'logout':
      return cmdLogout(args);
    case 'list':
      return cmdList(args);
    default:
      console.error(__doc());
      process.exit(1);
  }
}

function __doc() {
  return `atproto-login: generic AT Protocol OAuth login shim for CLI tools

Commands:
  login <handle-or-did>   Start an OAuth loopback login, print a URL to open
  whoami                  Verify stored creds by calling com.atproto.server.getSession
  refresh                 Force-refresh the stored access token
  call <nsid>              Make an authenticated XRPC call
  logout                  Delete stored credentials
  list                    List saved profiles

Options: --profile NAME (default: "default"), --scope "...", --get k=v, --input '<json>', --host pds|auth|<url>`;
}

main().catch((err) => {
  console.error('[atproto-login] Error:', err.message);
  process.exit(1);
});
