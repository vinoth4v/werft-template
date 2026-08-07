/**
 * Print a WERFT_PASSWORD_HASH value.
 *
 *   pnpm hash-password '<password>'
 *   printf '%s' '<password>' | pnpm hash-password
 *
 * Quote the password so the shell does not eat it, and prefer a shell that
 * does not persist history for this one line. Piping avoids both problems, and
 * keeps the password out of process listings — which is how the scaffold
 * script calls this.
 */
import { readFileSync } from "node:fs"
import { hashPassword } from "../src/auth/password.ts"

const password = process.argv[2] ?? readPipedPassword()

if (!password) {
  console.error("usage: pnpm hash-password '<password>'   (or pipe it on stdin)")
  process.exit(1)
}

if (password.length < 12) {
  console.error("refusing: use at least 12 characters")
  process.exit(1)
}

console.log(hashPassword(password))

/**
 * Reads a piped password, or returns empty when stdin is a terminal — so an
 * argument-less interactive call prints usage instead of hanging.
 */
function readPipedPassword(): string {
  if (process.stdin.isTTY) return ""

  try {
    return readFileSync(0, "utf8").trim()
  } catch {
    return ""
  }
}
