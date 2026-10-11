/**
 * Applies the checked-in migrations to DATABASE_URL over node-postgres, the
 * same driver the app uses at runtime. Run by deploy/start.mjs before the app
 * starts (a failure stops the new container, so the old one keeps serving), by
 * the scaffold against a new app's database, and by hand as `pnpm db:migrate`.
 *
 * A script rather than `drizzle-kit migrate`: the CLI once hung for ~60s and
 * failed silently in CI, 4/4 times, against a healthy database; running the
 * migrator in-process has never shown that.
 */
import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { Pool } from "pg"

const url = process.env.DATABASE_URL
if (!url) {
  console.error("DATABASE_URL is not set")
  process.exit(1)
}

const pool = new Pool({ connectionString: url, max: 1 })
try {
  await migrate(drizzle(pool), { migrationsFolder: "src/db/migrations" })
  console.log("migrations applied successfully")
} finally {
  await pool.end()
}
