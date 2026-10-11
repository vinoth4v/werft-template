Self-hosting only: stands in for `@neondatabase/serverless` and talks to a plain Postgres through node-postgres.
The Dockerfile swaps it in at build time; local development keeps the real Neon driver.
