/**
 * Applies migrations over the same neon-http (HTTP) driver the app itself
 * uses at runtime, instead of `drizzle-kit migrate`'s CLI, which defaults to
 * a websocket-based Pool.
 *
 * Real, reproducible failure this replaces: `drizzle-kit migrate` hung for
 * ~60s then failed with no error message, 4/4 times, in GitHub Actions —
 * against a branch independently confirmed healthy (a direct HTTP query
 * returned in 531ms, a websocket Pool query in 1087ms, and the CLI itself
 * succeeded in 2s run locally against the identical connection string). The
 * one variable that differed was the runner network path to Neon's
 * websocket proxy specifically. The neon-http driver never opens a
 * websocket at all, so it cannot hit that failure mode.
 */
import { neon } from "@neondatabase/serverless"
import { drizzle } from "drizzle-orm/neon-http"
import { migrate } from "drizzle-orm/neon-http/migrator"

const url = process.env.DATABASE_URL
if (!url) {
  console.error("DATABASE_URL is not set")
  process.exit(1)
}

const db = drizzle(neon(url))

await migrate(db, { migrationsFolder: "src/db/migrations" })
console.log("migrations applied successfully")
