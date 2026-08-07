import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

/**
 * Executes the entry point.
 *
 * Every other test in this package imports modules, which is how 30 passing
 * tests once coexisted with a CLI that crashed on its first invocation: Node
 * rejected a TypeScript construct that only mattered when the file was run.
 * Nothing catches that except actually running it.
 */

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url))

function runCli(...args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    // No stdin: the CLI must not wait for a prompt it cannot get an answer to.
    stdio: ["ignore", "pipe", "pipe"],
  })
}

describe("cli", () => {
  it("executes and exits 0 for --help", () => {
    const result = runCli("--help")

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("create-werft-app")
    expect(result.stdout).toContain("--dry-run")
  })

  it("does not fail to parse as a program", () => {
    // The specific regression: strip-only type stripping refusing to load it.
    const result = runCli("--help")

    expect(result.stderr).not.toContain("SyntaxError")
    expect(result.stderr).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX")
  })

  it("exits 2 on an unknown flag, and says which one", () => {
    const result = runCli("--nope")

    expect(result.status).toBe(2)
    expect(result.stderr).toContain("--nope")
  })

  it("exits 2 rather than hanging when required values are missing", () => {
    const result = runCli("--yes")

    expect(result.status).toBe(2)
    expect(result.stderr).toContain("--name")
  })

  it("exits 1 on a name that could not be a repo, Neon and Vercel project", () => {
    const result = runCli("--name", "BadName", "--description", "x", "--dry-run", "--yes")

    expect(result.status).toBe(1)
  })
})
