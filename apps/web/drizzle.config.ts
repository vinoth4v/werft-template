import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dbCredentials: {
    // Only read when actually talking to a database (`db:migrate`).
    // `db:generate` diffs the schema files and needs no connection.
    url: process.env.DATABASE_URL ?? "",
  },
  strict: true,
  verbose: true,
})
