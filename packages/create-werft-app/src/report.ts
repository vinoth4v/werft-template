import type { Resource } from "./ledger.ts"

/**
 * The cleanup report printed when rollback could not remove something.
 *
 * Extracted from the CLI so the promise it makes — one exact command per
 * surviving resource, never a vague apology — is testable.
 */
export function formatCleanupReport(orphaned: readonly Resource[]): string {
  if (orphaned.length === 0) {
    return "Nothing was left behind."
  }

  const lines = [
    `${orphaned.length} resource(s) could not be removed automatically.`,
    "Run these to clean up:",
    "",
  ]

  for (const resource of orphaned) {
    lines.push(`  # ${resource.what}`)
    lines.push(`  ${resource.cleanup}`)
    lines.push("")
  }

  return lines.join("\n").trimEnd()
}
