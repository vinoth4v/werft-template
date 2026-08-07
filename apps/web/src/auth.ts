import NextAuth from "next-auth"
import Credentials from "next-auth/providers/credentials"
import { z } from "zod"
import { verifyPassword } from "@/auth/password"
import { authConfig } from "@/auth.config"
import { recordEvent } from "@/db/events"
import { env } from "@/env"

const submitted = z.object({
  email: z.email(),
  password: z.string().min(1),
})

/**
 * Single-operator gate.
 *
 * There is no sign-up, no user table, and no password reset: the one allowed
 * identity is the email plus password hash in the environment. Adding a second
 * user means adding a real user store, not another env var.
 */
export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(raw) {
        const parsed = submitted.safeParse(raw)
        if (!parsed.success) return null

        const { email, password } = parsed.data
        const { WERFT_USER_EMAIL, WERFT_PASSWORD_HASH } = env()

        // Both checks always run, so a wrong email and a wrong password take
        // the same time and neither can be probed for independently.
        const emailMatches = email.toLowerCase() === WERFT_USER_EMAIL.toLowerCase()
        const passwordMatches = verifyPassword(password, WERFT_PASSWORD_HASH)

        if (!emailMatches || !passwordMatches) {
          await recordEvent("sign_in_failed", email)
          return null
        }

        await recordEvent("sign_in", WERFT_USER_EMAIL)
        return { id: "operator", email: WERFT_USER_EMAIL, name: "Operator" }
      },
    }),
  ],
})
