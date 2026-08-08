import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { renderWerftJson, validateWerftJson, type WerftJson } from "./werft-json.ts"

const valid: WerftJson = {
  name: "example-app",
  description: "An app that does a thing.",
  stack: ["next", "neon"],
  url: "https://example-app.vercel.app",
  tags: ["personal"],
  status: "active",
  private: true,
}

describe("werft.json", () => {
  it("accepts a well-formed file", () => {
    expect(validateWerftJson(valid)).toEqual([])
  })

  it("accepts an empty url, for an app that is not deployed yet", () => {
    expect(validateWerftJson({ ...valid, url: "" })).toEqual([])
  })

  it("rejects a name that could not be a repo, Neon and Vercel project", () => {
    for (const name of ["Example", "has space", "-leading", "trailing-", "x", ""]) {
      expect(validateWerftJson({ ...valid, name }), name).not.toEqual([])
    }
  })

  it("rejects a non-https url", () => {
    expect(validateWerftJson({ ...valid, url: "http://example.com" })).not.toEqual([])
  })

  it("rejects an unknown status", () => {
    expect(validateWerftJson({ ...valid, status: "live" })).not.toEqual([])
  })

  it("rejects keys the registry does not read", () => {
    const problems = validateWerftJson({ ...valid, owner: "me" })
    expect(problems.some((problem) => problem.includes("owner"))).toBe(true)
  })

  it("rejects anything that looks like a secret", () => {
    // werft.json is committed and the repo may be public.
    for (const key of ["token", "apiKey", "api_key", "password", "credentials"]) {
      const problems = validateWerftJson({ ...valid, [key]: "value" })
      expect(
        problems.some((problem) => problem.includes("secret")),
        key,
      ).toBe(true)
    }
  })

  it("rejects things that are not objects", () => {
    for (const value of [null, [], "string", 7]) {
      expect(validateWerftJson(value)).not.toEqual([])
    }
  })

  it("renders a stable key order with a trailing newline", () => {
    const rendered = renderWerftJson({ ...valid, private: false })
    expect(Object.keys(JSON.parse(rendered))).toEqual([
      "name",
      "description",
      "stack",
      "url",
      "tags",
      "status",
      "private",
    ])
    expect(rendered.endsWith("}\n")).toBe(true)
  })

  it("round-trips through render and validate", () => {
    expect(validateWerftJson(JSON.parse(renderWerftJson(valid)))).toEqual([])
  })

  it("considers this repo's own werft.json valid", async () => {
    // The template is itself a Werft app, so its file has to pass.
    const path = fileURLToPath(new URL("../../../werft.json", import.meta.url))
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"))

    expect(validateWerftJson(parsed)).toEqual([])
  })
})

describe("title", () => {
  it("is optional — an app without branding is still valid", () => {
    const { title, ...withoutTitle } = { ...valid, title: "X" }
    expect(validateWerftJson(withoutTitle)).toEqual([])
  })

  it("accepts a display name the slug rules could never allow", () => {
    expect(validateWerftJson({ ...valid, title: "SruthiScribe Learn" })).toEqual([])
  })

  it("rejects a present-but-empty title, which would render a blank heading", () => {
    expect(validateWerftJson({ ...valid, title: "   " })).toContain(
      "title must be a non-empty string when present",
    )
  })

  it("rejects a title too long to be a heading", () => {
    expect(validateWerftJson({ ...valid, title: "a".repeat(61) })).toContain(
      "title must be 60 characters or fewer",
    )
  })

  it("is written between name and description, so diffs stay stable", () => {
    const rendered = renderWerftJson({ ...valid, title: "Werft Template" })
    expect(Object.keys(JSON.parse(rendered))).toEqual([
      "name",
      "title",
      "description",
      "stack",
      "url",
      "tags",
      "status",
      "private",
    ])
  })

  it("omits the key entirely when there is no title", () => {
    expect(JSON.parse(renderWerftJson(valid))).not.toHaveProperty("title")
  })
})
