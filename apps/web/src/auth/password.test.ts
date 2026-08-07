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
    expect(verifyPassword("café", hash)).toBe(true)
  })

  it("returns false for malformed hashes instead of throwing", () => {
    const malformed = [
      "",
      "not-a-hash",
      "scrypt$16384$8$1$deadbeef",
      "bcrypt$16384$8$1$dead$beef",
      "scrypt$16384$8$1$nothex$nothex",
      "scrypt$0$8$1$dead$beef",
      "scrypt$99999999$8$1$dead$beef",
    ]

    for (const hash of malformed) {
      expect(verifyPassword("anything", hash), hash).toBe(false)
    }
  })

  it("rejects a hash whose key has been tampered with", () => {
    const hash = hashPassword("original")
    const flipped = hash.endsWith("0") ? `${hash.slice(0, -1)}1` : `${hash.slice(0, -1)}0`
    expect(verifyPassword("original", flipped)).toBe(false)
  })
})
