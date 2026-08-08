import { spawnSync } from "node:child_process"

/**
 * The build Vercel runs, which applies migrations before building — but only
 * for production.
 *
 * Without this, nothing ever migrated the production database. A pull request
 * adding a migration passed every gate honestly, because `neon-preview-branch`
 * gives each PR its own database branch and migrates it, so the preview really
 * worked. Then the merge deployed code querying a table production did not
 * have. The gates cannot catch that: the only environment nobody migrated was
 * the one nobody tested.
 *
 * **Production only, deliberately.** Preview branch databases are already
 * migrated by the PR workflow, so doing it here would be redundant — and worse
 * than redundant. Vercel resolves a preview deployment's DATABASE_URL to the
 * PR-scoped value when one exists, and otherwise falls back to the
 * preview-target value, which the scaffold sets to the production connection
 * string. A branch pushed before its PR exists would therefore have migrated
 * production, from unreviewed code. Gating on VERCEL_ENV removes that
 * possibility entirely rather than relying on the fallback never happening.
 *
 * A failing migration fails the build, so the previous deployment keeps
 * serving. That is the right direction to fail in: today's alternative is a
 * successful deploy of an app that errors on its first query.
 *
 * `pnpm build` is untouched and still needs no database — the rule that
 * `next build` works without secrets is what keeps this repo buildable by
 * anyone who clones it.
 */

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" })
  if (result.status !== 0) {
    console.error(`\n${command} ${args.join(" ")} exited ${result.status ?? "with a signal"}`)
    process.exit(result.status ?? 1)
  }
}

const target = process.env.VERCEL_ENV ?? "unknown"

if (target === "production") {
  if (!process.env.DATABASE_URL) {
    // Fail rather than build: a production deploy with no database is not
    // something to discover from a 500 later.
    console.error("VERCEL_ENV=production but DATABASE_URL is not set — refusing to build")
    process.exit(1)
  }
  console.log("production build: applying migrations before building")
  run("pnpm", ["run", "db:migrate"])
} else {
  console.log(
    `${target} build: skipping migrations — preview databases are migrated by the PR workflow, and this build must never touch production`,
  )
}

// The app's own build script, not `next build` directly: that one also builds
// the token stylesheet, and skipping it deploys an app with no CSS custom
// properties — which looks like a styling bug rather than a missing step.
run("pnpm", ["run", "build"])
