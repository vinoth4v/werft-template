import { describe, expect, it } from "vitest"
import { DEFAULT_TEMPLATE, helpText, parseArgs } from "./args.ts"

function parse(...argv: string[]) {
  const result = parseArgs(argv)
  if (!result.ok) throw new Error(`expected success, got: ${result.error}`)
  return result.options
}

describe("parseArgs", () => {
  it("defaults to a private, undeployed prototype from the published template", () => {
    const options = parse()
    expect(options.template).toBe(DEFAULT_TEMPLATE)
    expect(options.status).toBe("prototype")
    expect(options.private).toBe(true)
    expect(options.dryRun).toBe(false)
    expect(options.deploy).toBe(false)
    expect(options.rollback).toBe(true)
  })

  it("reads values as both --flag value and --flag=value", () => {
    expect(parse("--name", "my-app").name).toBe("my-app")
    expect(parse("--name=my-app").name).toBe("my-app")
  })

  it("splits comma-separated lists and drops the gaps", () => {
    expect(parse("--tags", "a, b ,,c").tags).toEqual(["a", "b", "c"])
  })

  it("treats --public as the negative of --private", () => {
    expect(parse("--public").private).toBe(false)
    expect(parse("--private").private).toBe(true)
  })

  it("treats --no-rollback as the negative of rollback", () => {
    expect(parse("--no-rollback").rollback).toBe(false)
  })

  it("accepts --dry-run", () => {
    expect(parse("--dry-run").dryRun).toBe(true)
  })

  it("rejects an unknown flag rather than ignoring it", () => {
    const result = parseArgs(["--wat"])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("--wat")
  })

  it("rejects a bare argument", () => {
    expect(parseArgs(["my-app"]).ok).toBe(false)
  })

  it("rejects a value flag with nothing after it", () => {
    expect(parseArgs(["--name"]).ok).toBe(false)
    expect(parseArgs(["--name="]).ok).toBe(false)
  })

  it("rejects a value handed to a boolean flag", () => {
    expect(parseArgs(["--dry-run=true"]).ok).toBe(false)
  })

  it("rejects an unknown status", () => {
    expect(parseArgs(["--status", "live"]).ok).toBe(false)
    expect(parseArgs(["--status", "archived"]).ok).toBe(true)
  })

  it("does not mistake a value for a flag", () => {
    // A description that starts with a dash must survive.
    expect(parse("--description=-- odd but legal").description).toBe("-- odd but legal")
  })

  it("documents every flag it accepts", () => {
    const text = helpText()
    for (const flag of ["--dry-run", "--deploy", "--no-rollback", "--skip-browsers", "--status"]) {
      expect(text, flag).toContain(flag)
    }
    expect(text).toContain("NEON_API_KEY")
  })
})
