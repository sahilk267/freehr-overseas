import { createHash, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const derive = promisify(scrypt);
const HASH_FORMAT = /^scrypt:([a-f0-9]{32}):([a-f0-9]{128})$/;

export function isOwnerPasswordHash(value: string | undefined): boolean {
  return Boolean(value && HASH_FORMAT.test(value));
}

export function ownerCredentialVersion() {
  return createHash("sha256").update(process.env.OWNER_PASSWORD_HASH ?? "").digest("hex");
}

export async function verifyOwnerPassword(password: string) {
  const parts = HASH_FORMAT.exec(process.env.OWNER_PASSWORD_HASH ?? "");
  if (!parts || password.length < 1 || password.length > 256) return false;
  const actual = await derive(password, parts[1], 64) as Buffer;
  return timingSafeEqual(actual, Buffer.from(parts[2], "hex"));
}

// A process-wide bound also works behind a proxy without trusting forwarded IPs.
// It limits expensive password derivations and never accumulates attacker keys.
export function createOwnerLoginLimiter() {
  let start = 0, attempts = 0;
  return (now = Date.now()) => {
    if (now - start >= 60_000) { start = now; attempts = 0; }
    return ++attempts <= 10;
  };
}
