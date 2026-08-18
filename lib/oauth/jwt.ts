import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Minimal HS256 JWT, hand-rolled to avoid a dependency.
 *
 * Real JWTs rather than an opaque signed blob is a deliberate choice: every
 * token this server issues can be pasted into jwt.io and read, which is the
 * whole point of running your own authorization server instead of renting
 * one. The signature is HMAC, not RSA, because the only party that ever
 * verifies these tokens is the same process that issued them — there is no
 * third party needing a public key, so there is no JWKS endpoint here.
 */

export type Claims = Record<string, unknown> & {
  /** Token flavour: "client" | "code" | "access" | "refresh". */
  typ: string;
  iss?: string;
  aud?: string;
  sub?: string;
  exp?: number;
  iat?: number;
};

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(data: string, key: string): string {
  return createHmac("sha256", key).update(data).digest("base64url");
}

export function signJwt(claims: Claims, key: string, ttlSeconds?: number): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: Claims = {
    iat: now,
    ...claims,
    ...(ttlSeconds ? { exp: now + ttlSeconds } : {}),
  };
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  return `${header}.${body}.${sign(`${header}.${body}`, key)}`;
}

export class JwtError extends Error {}

/**
 * Verifies signature, algorithm, and expiry. Everything else — audience,
 * issuer, token flavour — is the caller's job, because getting those wrong
 * is how tokens minted for one purpose get replayed at another.
 */
export function verifyJwt(token: string, key: string): Claims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JwtError("malformed token");
  const [header, body, signature] = parts;

  const expected = Buffer.from(sign(`${header}.${body}`, key));
  const actual = Buffer.from(signature);
  // Length check first: timingSafeEqual throws on a length mismatch rather
  // than returning false, and a thrown exception is itself a timing signal.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new JwtError("bad signature");
  }

  let head: { alg?: string };
  let claims: Claims;
  try {
    head = JSON.parse(Buffer.from(header, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new JwtError("unparseable token");
  }

  // Pin the algorithm. Accepting whatever the token names is the classic
  // JWT footgun — "alg": "none" would otherwise verify anything.
  if (head.alg !== "HS256") throw new JwtError(`unexpected alg: ${head.alg}`);

  if (typeof claims.exp === "number" && claims.exp < Math.floor(Date.now() / 1000)) {
    throw new JwtError("token expired");
  }
  return claims;
}

/** Compares two secrets without leaking their contents through timing. */
export function secretEquals(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
