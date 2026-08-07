import type { NextAuthConfig } from "next-auth"

/**
 * The half of the auth config that must run at the edge.
 *
 * Middleware is bundled for the edge runtime, so this file may not reach for
 * anything Node-only. The Credentials provider needs `node:crypto`, so it
 * lives in auth.ts and is composed on top of this.
 */
export const authConfig = {
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
  },
  callbacks: {
    authorized({ auth }) {
      return Boolean(auth?.user)
    },
  },
  providers: [],
} satisfies NextAuthConfig
