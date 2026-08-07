import { randomBytes, scryptSync } from "node:crypto"
import { describe, expect, it } from "vitest"
import { hashPassword, verifyPassword } from "./password.ts"

describe("password hashing", () => {
  it("accepts the password it hashed", () => {
    const hash = hashPassword("correct horse battery staple")
    expect(verifyPassword("correct horse battery staple", hash)).toBe(true)
  })

  it("rejects a wrong password", () => {
    const hash = hashPassword("correct horse battery staple")
    expect(verifyPassword("Correct horse battery staple", hash)).toBe(false)
    expect(verifyPassword("", hash)).toBe(false)
  })

  it("salts, so the same password hashes differently every time", () => {
    expect(hashPassword("same input")).not.toBe(hashPassword("same input"))
  })

  it("treats equivalent unicode spellings as the same password", () => {
    // "é" as one code point vs. "e" + combining acute.
    const hash = hashPassword("café")
    expect(verifyPassword("café", hash)).toBe(true)
  })

  it("encodes the pinned cost parameters", () => {
    const [prefix, n, r, p] = hashPassword("any password at all").split("$")
    expect([prefix, n, r, p]).toEqual(["scrypt", "65536", "8", "1"])
  })

  it("verifies hashes made with older, cheaper parameters", () => {
    // The claim that cost can be raised without invalidating existing hashes,
    // exercised against a hash built with the previous N.
    const salt = randomBytes(16)
    const key = scryptSync("legacy password", salt, 64, { N: 16384, r: 8, p: 1 })
    const legacy = ["scrypt", 16384, 8, 1, salt.toString("hex"), key.toString("hex")].join("$")

    expect(verifyPassword("legacy password", legacy)).toBe(true)
  })

  it("returns false for malformed hashes instead of throwing", () => {
    const malformed = [
      "",
      "not-a-hash",
      "scrypt$65536$8$1$deadbeef",
      "bcrypt$65536$8$1$dead$beef",
      "scrypt$65536$8$1$nothex$nothex",
      "scrypt$0$8$1$dead$beef",
      "scrypt$99999999$8$1$dead$beef",
    ]

    for (const hash of malformed) {
      expect(verifyPassword("anything", hash), hash).toBe(false)
    }
  })

  it("refuses a hash demanding more memory than the ceiling allows", () => {
    // 128 * 2^21 * 8 is 2 GiB. Parseable, well-formed, and must not be run.
    expect(verifyPassword("anything", `scrypt$${2 ** 21}$8$1$dead$beef`)).toBe(false)
  })

  it("rejects a hash whose key has been tampered with", () => {
    const hash = hashPassword("original")
    const flipped = hash.endsWith("0") ? `${hash.slice(0, -1)}1` : `${hash.slice(0, -1)}0`
    expect(verifyPassword("original", flipped)).toBe(false)
  })
})
