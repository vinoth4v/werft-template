import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto"

/**
 * Password hashing on `node:crypto` scrypt.
 *
 * No bcrypt/argon2 dependency on purpose: those need a native build step, and
 * a template that fails to install on a fresh machine is worse than one with
 * slightly less fashionable KDF parameters.
 *
 * Encoded form: scrypt$N$r$p$saltHex$keyHex
 */

const PREFIX = "scrypt"
const KEY_LENGTH = 64
const SALT_LENGTH = 16

/**
 * scrypt cost. These happen to equal Node's current defaults, and are pinned
 * here anyway: a future Node release changing its defaults must not silently
 * change how passwords are hashed.
 *
 * N=16384, r=8 costs 128 * N * r bytes => 16 MiB per hash, which stays under
 * Node's 32 MiB scrypt memory ceiling. Raising N means raising `maxmem` too,
 * so the two are not independent knobs.
 *
 * Both are encoded into every hash string, so raising them later verifies old
 * hashes correctly — a rehash-on-next-sign-in is not needed to move.
 */
const COST = { N: 16384, r: 8, p: 1 } as const

// Refuse absurd parameters read from the environment rather than allocating
// gigabytes because a hash string was mistyped.
const MAX_N = 1 << 20

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LENGTH)
  const key = scryptSync(normalize(password), salt, KEY_LENGTH, { ...COST })

  return [PREFIX, COST.N, COST.r, COST.p, salt.toString("hex"), key.toString("hex")].join("$")
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$")
  if (parts.length !== 6) return false

  const [prefix, rawN, rawR, rawP, saltHex, keyHex] = parts
  if (prefix !== PREFIX) return false
  if (rawN === undefined || rawR === undefined || rawP === undefined) return false
  if (saltHex === undefined || keyHex === undefined) return false
  if (!isHex(saltHex) || !isHex(keyHex)) return false

  const N = Number(rawN)
  const r = Number(rawR)
  const p = Number(rawP)
  if (![N, r, p].every((value) => Number.isInteger(value) && value > 0)) return false
  if (N > MAX_N || r > 32 || p > 16) return false

  const expected = Buffer.from(keyHex, "hex")
  if (expected.length === 0) return false

  let actual: Buffer
  try {
    actual = scryptSync(normalize(password), Buffer.from(saltHex, "hex"), expected.length, {
      N,
      r,
      p,
    })
  } catch {
    return false
  }

  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/** Unicode-normalise so the same typed password always hashes the same way. */
function normalize(password: string): string {
  return password.normalize("NFKC")
}

function isHex(value: string): boolean {
  return value.length > 0 && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value)
}
