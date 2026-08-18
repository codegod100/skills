// Shared helpers for the atproto-login shim: identity resolution, DPoP proof
// signing, and a nonce-retrying fetch wrapper. Pure Node, no npm deps.

import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const STORE_DIR = path.join(os.homedir(), '.atproto-login-shim');

export function profilePath(profile) {
  return path.join(STORE_DIR, `${profile}.json`);
}

export function loadProfile(profile) {
  const p = profilePath(profile);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function saveProfile(profile, data) {
  fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  const p = profilePath(profile);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.chmodSync(p, 0o600);
}

export function deleteProfile(profile) {
  const p = profilePath(profile);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

// --- base64url --------------------------------------------------------

export function b64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf.toString('base64url');
}

export function sha256(input) {
  return crypto.createHash('sha256').update(input).digest();
}

// --- PKCE ---------------------------------------------------------------

export function makePkce() {
  const codeVerifier = b64url(crypto.randomBytes(32)); // 43 chars, within 43-128 spec range
  const codeChallenge = b64url(sha256(codeVerifier));
  return { codeVerifier, codeChallenge };
}

// --- DPoP key + proof -----------------------------------------------------

export function generateDpopKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
    namedCurve: 'prime256v1', // P-256, required for ES256
  });
  return {
    privateKeyJwk: privateKey.export({ format: 'jwk' }),
    publicKeyJwk: publicKey.export({ format: 'jwk' }),
  };
}

function jwkToKeyObject(jwk, type) {
  return type === 'private'
    ? crypto.createPrivateKey({ key: jwk, format: 'jwk' })
    : crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

/**
 * Build a signed DPoP proof JWT per RFC 9449.
 * @param {object} opts
 * @param {object} opts.privateKeyJwk - DPoP private key (JWK, from generateDpopKeyPair)
 * @param {object} opts.publicKeyJwk - DPoP public key (JWK)
 * @param {string} opts.htm - HTTP method, e.g. 'POST'
 * @param {string} opts.htu - HTTP target URI, WITHOUT query/fragment
 * @param {string} [opts.nonce] - server-issued DPoP-Nonce, if known
 * @param {string} [opts.accessToken] - bind proof to an access token (adds `ath` claim)
 */
export function dpopProof({ privateKeyJwk, publicKeyJwk, htm, htu, nonce, accessToken }) {
  const privateKey = jwkToKeyObject(privateKeyJwk, 'private');

  const header = {
    typ: 'dpop+jwt',
    alg: 'ES256',
    jwk: {
      kty: publicKeyJwk.kty,
      crv: publicKeyJwk.crv,
      x: publicKeyJwk.x,
      y: publicKeyJwk.y,
    },
  };
  const payload = {
    jti: b64url(crypto.randomBytes(16)),
    htm,
    htu,
    iat: Math.floor(Date.now() / 1000),
  };
  if (nonce) payload.nonce = nonce;
  if (accessToken) payload.ath = b64url(sha256(accessToken));

  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.sign('sha256', Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${b64url(sig)}`;
}

function stripQuery(url) {
  const u = new URL(url);
  u.search = '';
  u.hash = '';
  return u.toString();
}

/**
 * fetch() wrapper that attaches a DPoP proof and transparently retries once
 * if the server rejects the request for a stale/missing nonce (mandatory
 * per the atproto OAuth / RFC 9449 DPoP-Nonce dance). Always captures any
 * DPoP-Nonce response header into `nonces` for reuse on the next call.
 */
export async function dpopFetch(url, { method = 'GET', headers = {}, body, dpopKeys, nonces, accessToken } = {}) {
  const origin = new URL(url).origin;
  const htu = stripQuery(url);

  const attempt = async () => {
    const proof = dpopProof({
      privateKeyJwk: dpopKeys.privateKeyJwk,
      publicKeyJwk: dpopKeys.publicKeyJwk,
      htm: method,
      htu,
      nonce: nonces?.[origin],
      accessToken,
    });
    const reqHeaders = { ...headers, DPoP: proof };
    if (accessToken) reqHeaders.Authorization = `DPoP ${accessToken}`;
    const res = await fetch(url, { method, headers: reqHeaders, body });
    const newNonce = res.headers.get('dpop-nonce');
    if (newNonce && nonces) nonces[origin] = newNonce;
    return res;
  };

  let res = await attempt();
  if (res.status === 400 || res.status === 401) {
    // Peek at the body without consuming it for the caller if we don't retry.
    const clone = res.clone();
    let errBody = null;
    try {
      errBody = await clone.json();
    } catch {
      /* not JSON, ignore */
    }
    const needsNonceRetry =
      res.headers.get('dpop-nonce') &&
      (errBody?.error === 'use_dpop_nonce' || errBody?.error === 'invalid_dpop_proof' || !nonces?.[origin]);
    if (needsNonceRetry) {
      res = await attempt();
    }
  }
  return res;
}

// --- Identity resolution: handle/DID -> DID doc -> PDS -------------------

export function isDid(input) {
  return input.startsWith('did:');
}

async function resolveHandleViaDns(handle) {
  try {
    const records = await dns.resolveTxt(`_atproto.${handle}`);
    for (const rec of records) {
      const joined = rec.join('');
      if (joined.startsWith('did=')) return joined.slice(4);
    }
  } catch {
    /* fall through to next method */
  }
  return null;
}

async function resolveHandleViaHttp(handle) {
  try {
    const res = await fetch(`https://${handle}/.well-known/atproto-did`);
    if (res.ok) {
      const text = (await res.text()).trim();
      if (text.startsWith('did:')) return text;
    }
  } catch {
    /* fall through */
  }
  return null;
}

async function resolveHandleViaPublicApi(handle) {
  try {
    const res = await fetch(
      `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
    );
    if (res.ok) {
      const json = await res.json();
      if (json.did?.startsWith('did:')) return json.did;
    }
  } catch {
    /* fall through */
  }
  return null;
}

export async function resolveHandleToDid(handle) {
  return (
    (await resolveHandleViaDns(handle)) ||
    (await resolveHandleViaHttp(handle)) ||
    (await resolveHandleViaPublicApi(handle)) ||
    (() => {
      throw new Error(`Could not resolve handle to a DID: ${handle}`);
    })()
  );
}

export async function resolveDidDoc(did) {
  if (did.startsWith('did:plc:')) {
    const res = await fetch(`https://plc.directory/${did}`);
    if (!res.ok) throw new Error(`plc.directory lookup failed for ${did}: HTTP ${res.status}`);
    return res.json();
  }
  if (did.startsWith('did:web:')) {
    const idPart = did.slice('did:web:'.length);
    const segments = idPart.split(':').map(decodeURIComponent);
    const domain = segments[0];
    const pathSegments = segments.slice(1);
    const url =
      pathSegments.length > 0
        ? `https://${domain}/${pathSegments.join('/')}/did.json`
        : `https://${domain}/.well-known/did.json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`did:web lookup failed for ${did}: HTTP ${res.status}`);
    return res.json();
  }
  throw new Error(`Unsupported DID method: ${did}`);
}

export function pdsFromDidDoc(didDoc) {
  const svc = (didDoc.service || []).find(
    (s) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer',
  );
  if (!svc) throw new Error('DID document has no #atproto_pds service entry');
  return svc.serviceEndpoint;
}

/**
 * Full identity -> PDS -> authorization server metadata resolution.
 * `input` may be a handle or a DID.
 */
export async function resolveIdentity(input, { skipHandleVerification = false } = {}) {
  const did = isDid(input) ? input : await resolveHandleToDid(input);
  const didDoc = await resolveDidDoc(did);

  if (!isDid(input) && !skipHandleVerification) {
    const aka = didDoc.alsoKnownAs || [];
    if (!aka.includes(`at://${input}`)) {
      throw new Error(
        `Handle verification failed: DID doc for ${did} does not list at://${input} in alsoKnownAs. ` +
          `Refusing to continue (possible spoofing). Pass a DID directly to bypass.`,
      );
    }
  }

  const pds = pdsFromDidDoc(didDoc);

  const prm = await fetch(new URL('/.well-known/oauth-protected-resource', pds));
  if (!prm.ok) throw new Error(`Failed to fetch protected-resource metadata from ${pds}: HTTP ${prm.status}`);
  const prmJson = await prm.json();
  const authServer = prmJson.authorization_servers?.[0];
  if (!authServer) throw new Error(`No authorization_servers advertised by ${pds}`);

  const asm = await fetch(new URL('/.well-known/oauth-authorization-server', authServer));
  if (!asm.ok) throw new Error(`Failed to fetch authorization-server metadata from ${authServer}: HTTP ${asm.status}`);
  const asMeta = await asm.json();

  return { did, didDoc, pds, authServer, asMeta };
}
