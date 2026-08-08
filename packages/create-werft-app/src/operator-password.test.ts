import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  type FleetApp,
  fetchFleet,
  isWerftApp,
  looksLikeHash,
  readStandingHash,
  refreshFleet,
  writeStandingHash,
} from "./operator-password.ts"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const HASH = "scrypt$65536$8$1$0011aabb$00ffeedd"

describe("looksLikeHash", () => {
  it("accepts what this template's hash-password produces", () => {
    expect(looksLikeHash(HASH)).toBe(true)
    expect(looksLikeHash(`${HASH}\n`)).toBe(true)
  })

  it("rejects anything else, so a placeholder can never be stored as a password", () => {
    // Vercel's own redaction string got this far once during development.
    for (const bad of [
      "",
      "[SENSITIVE]",
      "hunter2",
      "scrypt$",
      "bcrypt$10$abc",
      "scrypt$a$b$c$d$e",
    ]) {
      expect(looksLikeHash(bad), bad).toBe(false)
    }
  })
})

describe("writeStandingHash", () => {
  it("writes it owner-only, because it opens every app", async () => {
    const dir = await mkdtemp(join(tmpdir(), "werft-pw-"))
    const path = join(dir, "password-hash")
    await writeStandingHash(HASH, path)

    expect((await readFile(path, "utf8")).trim()).toBe(HASH)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readStandingHash(path)).toBe(HASH)
  })

  it("refuses to store a non-hash rather than locking every app out", async () => {
    const dir = await mkdtemp(join(tmpdir(), "werft-pw-"))
    await expect(writeStandingHash("[SENSITIVE]", join(dir, "h"))).rejects.toThrow("not a scrypt")
  })

  it("reads as empty when there is no file, rather than throwing", async () => {
    expect(await readStandingHash(join(tmpdir(), "definitely-absent-hash"))).toBe("")
  })
})

describe("fetchFleet", () => {
  it("sends the bearer token and returns the apps", async () => {
    const seen: { url?: string; auth?: string } = {}
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      seen.url = String(url)
      seen.auth = (init?.headers as Record<string, string>)?.Authorization
      return new Response(
        JSON.stringify({ apps: [{ name: "a", url: "https://a", status: "active" }] }),
        {
          status: 200,
        },
      )
    })

    const apps = await fetchFleet("https://registry.example", "tok")
    expect(apps).toEqual([{ name: "a", url: "https://a", status: "active" }])
    expect(seen.url).toBe("https://registry.example/api/registry/apps")
    expect(seen.auth).toBe("Bearer tok")
  })

  it("returns nothing on a rejected token instead of pretending the fleet is empty of failures", async () => {
    vi.stubGlobal("fetch", async () => new Response("no", { status: 401 }))
    expect(await fetchFleet("https://registry.example", "bad")).toEqual([])
  })
})

describe("isWerftApp", () => {
  it("is true only when the repo carries a werft.json", async () => {
    expect(await isWerftApp("scaffolded", async () => ({ code: 0 }))).toBe(true)
    expect(await isWerftApp("backfilled", async () => ({ code: 1 }))).toBe(false)
  })

  it("asks about the right repo", async () => {
    const seen: string[] = []
    await isWerftApp("my-app", async (args) => {
      seen.push(args.join(" "))
      return { code: 0 }
    })
    expect(seen[0]).toContain("repos/vinoth4v/my-app/contents/werft.json")
  })
})

describe("refreshFleet", () => {
  const apps: FleetApp[] = [
    { name: "live", url: "https://live.vercel.app", status: "active" },
    { name: "undeployed", url: "", status: "prototype" },
  ]

  it("skips an app that was never deployed, and does not call Vercel for it", async () => {
    const calls: string[] = []
    vi.stubGlobal("fetch", async (url: string | URL) => {
      calls.push(String(url))
      return new Response("{}", { status: 200 })
    })

    const outcomes = await refreshFleet(HASH, apps, "tok", () => {})
    expect(outcomes.find((o) => o.name === "undeployed")?.outcome).toBe("skipped")
    expect(calls.every((url) => !url.includes("undeployed"))).toBe(true)
  })

  it("reports env-only when the variable landed but the redeploy did not", async () => {
    // The distinction that matters: the new password is stored but not yet in
    // force, and saying "updated" here would be a lie.
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }))
    const exec = await import("./exec.ts")
    vi.spyOn(exec, "exec").mockResolvedValue({ code: 1, stdout: "", stderr: "no" })

    const outcomes = await refreshFleet(HASH, [apps[0] as FleetApp], "tok", () => {})
    expect(outcomes[0]?.outcome).toBe("env-only")
    expect(outcomes[0]?.detail).toContain("redeploy")
  })

  it("reports failed when Vercel refuses the variable", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 403 }))
    const outcomes = await refreshFleet(HASH, [apps[0] as FleetApp], "tok", () => {})
    expect(outcomes[0]?.outcome).toBe("failed")
  })

  it("upserts both targets, so a preview deployment accepts the password too", async () => {
    const bodies: string[] = []
    const urls: string[] = []
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      urls.push(String(url))
      if (typeof init?.body === "string") bodies.push(init.body)
      return new Response("{}", { status: 200 })
    })
    const exec = await import("./exec.ts")
    vi.spyOn(exec, "exec").mockResolvedValue({ code: 0, stdout: "", stderr: "" })

    await refreshFleet(HASH, [apps[0] as FleetApp], "tok", () => {})
    expect(urls[0]).toContain("upsert=true")
    const sent = JSON.parse(bodies[0] ?? "{}")
    expect(sent.target).toEqual(["production", "preview"])
    expect(sent.key).toBe("WERFT_PASSWORD_HASH")
  })
})
