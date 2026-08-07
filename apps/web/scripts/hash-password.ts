/**
 * Print a WERFT_PASSWORD_HASH value.
 *
 *   pnpm hash-password '<password>'
 *
 * Quote the password so the shell does not eat it, and prefer a shell that
 * does not persist history for this one line.
 */
import { hashPassword } from "../src/auth/password.ts"

const password = process.argv[2]

if (!password) {
  console.error("usage: pnpm hash-password '<password>'")
  process.exit(1)
}

if (password.length < 12) {
  console.error("refusing: use at least 12 characters")
  process.exit(1)
}

console.log(hashPassword(password))
