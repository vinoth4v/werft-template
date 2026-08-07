import { neon } from "@neondatabase/serverless"
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http"
import * as schema from "@/db/schema"
import { env } from "@/env"

let cached: NeonHttpDatabase<typeof schema> | undefined

/**
 * The database handle, opened on first use.
 *
 * A function rather than a module-scope constant so that importing this file
 * never requires DATABASE_URL — build and unit tests must not need a database.
 */
export function db(): NeonHttpDatabase<typeof schema> {
  cached ??= drizzle(neon(env().DATABASE_URL), { schema })
  return cached
}
