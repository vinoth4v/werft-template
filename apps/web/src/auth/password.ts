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
 * scrypt cost, pinned explicitly so that a future Node release changing its
 * own defaults cannot silently change how passwords are hashed.
 *
 * N=65536, r=8, p=1 costs 128 * N * r = 64 MiB per hash. That is above Node's
 * 32 MiB default ceiling, so every call must pass `maxmem` too — N and maxmem
 * are not independent knobs.
 *
 * All three are encoded into every hash and read back during verification, so
 * raising them again later keeps existing hashes working.
 */
const COST = { N: 65536, r: 8, p: 1 } as const

/**
 * Ceiling on memory a stored hash may ask for.
 *
 * Verification takes N and r from the hash string, so a mistyped or hostile
 * value could otherwise ask Node to allocate gigabytes.
 */
const MAX_MEMORY_BYTES = 256 * 1024 * 1024

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LENGTH)
  const key = scryptSync(normalize(password), salt, KEY_LENGTH, {
    ...COST,
    maxmem: maxmemFor(COST.N, COST.r),
  })

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
  if (r > 32 || p > 16) return false
  if (128 * N * r > MAX_MEMORY_BYTES) return false

  const expected = Buffer.from(keyHex, "hex")
  if (expected.length === 0) return false

  let actual: Buffer
  try {
    actual = scryptSync(normalize(password), Buffer.from(saltHex, "hex"), expected.length, {
      N,
      r,
      p,
      maxmem: maxmemFor(N, r),
    })
  } catch {
    return false
  }

  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

/**
 * scrypt needs 128 * N * r bytes. Ask for double, so Node's own accounting has
 * room and does not reject a parameter set we already decided is legitimate.
 */
function maxmemFor(N: number, r: number): number {
  return 128 * N * r * 2
}

/** Unicode-normalise so the same typed password always hashes the same way. */
function normalize(password: string): string {
  return password.normalize("NFKC")
}

function isHex(value: string): boolean {
  return value.length > 0 && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value)
}
