import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { Pool } from "pg"
import * as schema from "@/db/schema"
import { env } from "@/env"

let cached: NodePgDatabase<typeof schema> | undefined

/**
 * The database handle, opened on first use.
 *
 * A function rather than a module-scope constant so that importing this file
 * never requires DATABASE_URL — build and unit tests must not need a database.
 *
 * Plain Postgres over node-postgres: the app runs on the home server next to
 * its database (apps-db), and local development points DATABASE_URL at any
 * Postgres. A small pool, because one container serves one operator.
 */
export function db(): NodePgDatabase<typeof schema> {
  cached ??= drizzle(new Pool({ connectionString: env().DATABASE_URL, max: 5 }), { schema })
  return cached
}
