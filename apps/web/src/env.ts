import { z } from "zod"

const envSchema = z.object({
  DATABASE_URL: z.url(),
  AUTH_SECRET: z.string().min(32, "must be at least 32 characters"),
  WERFT_USER_EMAIL: z.email(),
  WERFT_PASSWORD_HASH: z.string().min(1),
})

export type Env = z.infer<typeof envSchema>

let cached: Env | undefined

/**
 * Validated environment, resolved on first use.
 *
 * Deliberately lazy: `next build` must not require secrets, so nothing may
 * read the environment at module scope.
 */
export function env(): Env {
  if (cached) return cached

  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".")} (${issue.message})`)
      .join(", ")
    throw new Error(`Invalid environment: ${problems}. See .env.example.`)
  }

  cached = parsed.data
  return cached
}
