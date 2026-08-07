import { describe, expect, it } from "vitest"
import type { Resource } from "./ledger.ts"
import { formatCleanupReport } from "./report.ts"

describe("formatCleanupReport", () => {
  it("says so plainly when nothing survived", () => {
    expect(formatCleanupReport([])).toBe("Nothing was left behind.")
  })

  it("prints one exact command for every surviving resource", () => {
    const orphaned: Resource[] = [
      { what: "GitHub repository me/app", cleanup: "gh repo delete me/app --yes" },
      { what: "Neon project br-x", cleanup: "curl -X DELETE ... br-x" },
    ]

    const report = formatCleanupReport(orphaned)

    // The whole point: every resource is named, and every one has a command.
    for (const resource of orphaned) {
      expect(report).toContain(resource.what)
      expect(report).toContain(resource.cleanup)
    }
    expect(report).toContain("2 resource(s)")
  })

  it("never reports a resource without telling you how to remove it", () => {
    const report = formatCleanupReport([{ what: "orphan", cleanup: "rm -rf orphan" }])
    const described = report.split("\n").filter((line) => line.trim().startsWith("# "))
    const commands = report
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.trim().startsWith("#") && line.startsWith("  "))

    expect(described).toHaveLength(1)
    expect(commands).toHaveLength(1)
  })
})
