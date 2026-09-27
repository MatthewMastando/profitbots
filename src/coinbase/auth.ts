// Coinbase Developer Platform (CDP) API key auth for Advanced Trade: a short-lived JWT per request.
// Per Coinbase's docs: header {alg, kid: keyName, nonce, typ: "JWT"}, payload {sub: keyName, iss: "cdp", nbf, exp: nbf+120,
// uri: "<METHOD> <host><path>"}. ECDSA (ES256) keys come as a PEM "EC PRIVATE KEY"; Ed25519 keys as 64 base64 bytes.
import { createPrivateKey, createSign, randomBytes, sign as edSign, type KeyObject } from "node:crypto";

export interface JwtKey {
  keyName: string;
  privateKey: string;
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** Loads either key format. Throws when the key material is unusable (message never includes the key). */
export function loadKey(pem: string): { key: KeyObject; alg: "ES256" | "EdDSA" } {
  const s = pem.trim();
  if (s.includes("-----BEGIN")) {
    try {
      return { key: createPrivateKey({ key: s, format: "pem" }), alg: "ES256" };
    } catch {
      throw new Error("COINBASE_API_PRIVATE_KEY is not a valid PEM EC private key");
    }
  }
  // Ed25519: 64 bytes base64 = 32-byte seed + 32-byte public key.
  const raw = Buffer.from(s, "base64");
  if (raw.length !== 64) throw new Error("COINBASE_API_PRIVATE_KEY is neither a PEM key nor a 64-byte base64 Ed25519 key");
  const seed = raw.subarray(0, 32);
  // PKCS#8 wrapper for an Ed25519 seed.
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  return { key: createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" }), alg: "EdDSA" };
}

/** DER ECDSA signature -> raw r||s (64 bytes) as JWS requires. */
function derToJose(der: Buffer): Buffer {
  let i = 2;
  const read = () => {
    i++; // 0x02
    let len = der[i++]!;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let k = 0; k < n; k++) len = (len << 8) | der[i++]!;
    }
    let v = der.subarray(i, i + len);
    i += len;
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);
    return Buffer.concat([Buffer.alloc(32 - v.length), v]);
  };
  if (der[1]! & 0x80) i += der[1]! & 0x7f;
  const r = read();
  const s = read();
  return Buffer.concat([r, s]);
}

export function buildJwt(k: JwtKey, method: string, host: string, path: string, now = Date.now()): string {
  const { key, alg } = loadKey(k.privateKey);
  const nbf = Math.floor(now / 1000);
  const header = { alg, kid: k.keyName, nonce: randomBytes(16).toString("hex"), typ: "JWT" };
  const payload = { sub: k.keyName, iss: "cdp", nbf, exp: nbf + 120, uri: `${method.toUpperCase()} ${host}${path}` };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  let sig: Buffer;
  if (alg === "ES256") {
    const signer = createSign("SHA256");
    signer.update(signingInput);
    sig = derToJose(signer.sign(key));
  } else sig = Buffer.from(edSign(null, Buffer.from(signingInput), key));
  return `${signingInput}.${b64url(sig)}`;
}

/** Decode a JWT's header and payload (tests / diagnostics). */
export function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [h, p] = token.split(".");
  return { header: JSON.parse(Buffer.from(h!, "base64url").toString()), payload: JSON.parse(Buffer.from(p!, "base64url").toString()) };
}
