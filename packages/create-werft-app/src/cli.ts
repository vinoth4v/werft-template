#!/usr/bin/env node
import { createInterface } from "node:readline/promises"
import { helpText, parseArgs } from "./args.ts"
import { type Logger, scaffold } from "./scaffold.ts"

const logger: Logger = {
  step: (text) => console.log(`\n▸ ${text}`),
  info: (text) => console.log(`  ${text}`),
  warn: (text) => console.warn(`! ${text}`),
  error: (text) => console.error(`✗ ${text}`),
}

const parsed = parseArgs(process.argv.slice(2))

if (!parsed.ok) {
  console.error(`✗ ${parsed.error}\n`)
  console.error(helpText())
  process.exit(2)
}

const options = parsed.options

if (options.help) {
  console.log(helpText())
  process.exit(0)
}

// Prompt only for what is missing, and only when there is somebody to answer.
if (!options.name || !options.description) {
  if (options.yes || !process.stdin.isTTY) {
    console.error("✗ --name and --description are required when not prompting\n")
    console.error(helpText())
    process.exit(2)
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    options.name ||= (await rl.question("app name: ")).trim()
    options.description ||= (await rl.question("one-line description: ")).trim()
  } finally {
    rl.close()
  }
}

if (options.dryRun) {
  logger.warn("dry run: local work is real, no remote resources will be created")
}

const outcome = await scaffold(options, logger)

if (outcome.ok) {
  console.log(`\n✓ ${options.dryRun ? "Dry run complete" : "Done"}: ${outcome.dir}`)
  if (outcome.url) console.log(`  ${outcome.url}`)

  if (outcome.notes.length > 0) {
    console.log("\nNotes:")
    for (const note of outcome.notes) console.log(`  - ${note}`)
  }

  console.log("\nNext:")
  console.log(`  cd ${outcome.dir}`)
  console.log("  pnpm dev")
  process.exit(0)
}

console.error(`\n✗ Failed at: ${outcome.failedAt}`)

if (outcome.orphaned.length > 0) {
  console.error(`\n${outcome.orphaned.length} resource(s) could not be removed automatically.`)
  console.error("Run these to clean up:\n")
  for (const resource of outcome.orphaned) {
    console.error(`  # ${resource.what}`)
    console.error(`  ${resource.cleanup}\n`)
  }
} else {
  console.error("\nNothing was left behind.")
}

if (outcome.notes.length > 0) {
  console.error("Notes:")
  for (const note of outcome.notes) console.error(`  - ${note}`)
}

process.exit(1)
