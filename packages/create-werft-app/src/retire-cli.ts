import { exec } from "./exec.ts"
import { retire } from "./retire.ts"

/**
 * `pnpm retire-app --name <app>` — remove an app and everything it owns.
 *
 * The confirmation is the app's own name, typed back. Not a --yes flag: a flag
 * is something you add once and then keep adding out of habit, whereas typing
 * "world-watch" is impossible to do by accident on the wrong app. Everything
 * here is unrecoverable, so being briefly annoying is the point.
 */

function help(): string {
  return `usage: pnpm retire-app --name <app> --confirm <app> [options]

Removes an app's Vercel project, Neon database, S3 buckets, scoped AWS user
and registry row. The GitHub repository is kept unless you ask for it.

options:
  --name <app>       the app to retire
  --confirm <app>    type the same name again to proceed
  --delete-repo      also delete the GitHub repository (the code is gone)
  --dry-run          list what would be removed, remove nothing
  --help
`
}

function flagValue(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag)
  return index === -1 ? "" : (args[index + 1] ?? "")
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(help())
    return args.length === 0 ? 1 : 0
  }

  const name = flagValue(args, "--name")
  const confirm = flagValue(args, "--confirm")
  const dryRun = args.includes("--dry-run")
  const deleteRepo = args.includes("--delete-repo")

  if (name === "") {
    console.error("--name is required")
    return 1
  }
  // Checked even for a dry run, so the habit is the same either way.
  if (confirm !== name) {
    console.error(
      confirm === ""
        ? `--confirm is required: pass --confirm ${name} to prove you mean this app`
        : `--confirm said "${confirm}" but --name said "${name}" — nothing was touched`,
    )
    return 1
  }

  console.log(
    dryRun
      ? `Dry run: what retiring ${name} would remove\n`
      : `Retiring ${name}${deleteRepo ? " and deleting its repository" : ""}\n`,
  )

  const result = await retire(
    {
      name,
      deleteRepo,
      dryRun,
      runGh: async (ghArgs) => {
        const outcome = await exec("gh", ghArgs)
        return { code: outcome.code, stderr: outcome.stderr }
      },
    },
    (line) => console.log(line),
  )

  if (dryRun) {
    console.log("\nNothing was removed.")
    return 0
  }

  if (result.complete) {
    console.log(`\n${name} is retired. Nothing was left behind.`)
    return 0
  }

  // The whole point of the per-step reporting: say what survived, so it can be
  // dealt with rather than quietly costing money.
  console.log(`\n${name} is PARTLY retired. Still there:`)
  for (const leftover of result.leftovers) console.log(`  - ${leftover}`)
  console.log("\nFix the cause and run this again; every step is safe to repeat.")
  return 1
}

process.exitCode = await main()
