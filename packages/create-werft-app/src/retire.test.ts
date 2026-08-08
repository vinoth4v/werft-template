import { afterEach, describe, expect, it, vi } from "vitest"
import { retire } from "./retire.ts"

afterEach(() => {
  vi.unstubAllGlobals()
})

const silent = () => {}

describe("retire", () => {
  it("touches nothing on a dry run", async () => {
    const calls: string[] = []
    vi.stubGlobal("fetch", async (url: string | URL) => {
      calls.push(String(url))
      return new Response("{}", { status: 200 })
    })

    const result = await retire(
      {
        name: "doomed",
        deleteRepo: true,
        dryRun: true,
        runGh: async () => ({ code: 0, stderr: "" }),
      },
      silent,
    )

    expect(calls).toEqual([])
    expect(result.steps).toEqual([])
    expect(result.complete).toBe(true)
  })

  it("keeps the repository unless asked, because the code is the irreplaceable part", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }))
    let ghCalled = false

    const result = await retire(
      {
        name: "doomed",
        deleteRepo: false,
        dryRun: true,
        runGh: async () => {
          ghCalled = true
          return { code: 0, stderr: "" }
        },
      },
      silent,
    )

    expect(ghCalled).toBe(false)
    const repoStep = result.steps.find((step) => step.what === "GitHub repository")
    expect(repoStep?.outcome).toBe("skipped")
    expect(repoStep?.detail).toContain("code is still there")
  })

  it("is not complete when a step failed, and names what survived", async () => {
    // No credentials in the environment: several steps must report failure
    // rather than quietly reporting nothing.
    vi.stubEnv("NEON_API_KEY", "")
    vi.stubEnv("WERFT_REGISTRY_TOKEN", "")
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 500 }))

    const result = await retire(
      {
        name: "doomed",
        deleteRepo: false,
        dryRun: false,
        runGh: async () => ({ code: 0, stderr: "" }),
      },
      silent,
    )

    expect(result.complete).toBe(false)
    expect(result.leftovers.length).toBeGreaterThan(0)
    // Every leftover must say which resource and why, since the operator has to
    // act on it: a bare "failed" would be useless.
    for (const leftover of result.leftovers) {
      expect(leftover).toMatch(/: .+/)
    }
  })

  it("reports the registry row absent rather than failed when it is already gone", async () => {
    vi.stubEnv("WERFT_REGISTRY_TOKEN", "tok")
    vi.stubGlobal("fetch", async (url: string | URL) =>
      String(url).includes("/api/registry/apps/")
        ? new Response("not found", { status: 404 })
        : new Response("{}", { status: 500 }),
    )

    const result = await retire(
      {
        name: "doomed",
        deleteRepo: false,
        dryRun: false,
        runGh: async () => ({ code: 0, stderr: "" }),
      },
      silent,
    )

    const row = result.steps.find((step) => step.what.startsWith("registry row"))
    expect(row?.outcome).toBe("absent")
  })
})
