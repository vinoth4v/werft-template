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
  const coolify = { base: "http://coolify.test/api/v1", token: "tok" }
  const apps: FleetApp[] = [
    { name: "live", url: "https://live.vinothkannan.de", status: "active" },
    { name: "elsewhere", url: "https://elsewhere.example", status: "active" },
  ]

  /** A fake Coolify: "live" exists, "elsewhere" does not. Records every call. */
  function fakeCoolify(
    overrides: { envStatus?: number; deployStatus?: number; firstEnvStatus?: number } = {},
  ) {
    const calls: { method: string; url: string; body: string }[] = []
    let envPosts = 0
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const u = String(url)
      const method = init?.method ?? "GET"
      calls.push({ method, url: u, body: typeof init?.body === "string" ? init.body : "" })
      if (u.endsWith("/applications") && method === "GET") {
        return new Response(JSON.stringify([{ uuid: "app-live", name: "live" }]), { status: 200 })
      }
      if (u.includes("/applications/app-live/envs")) {
        if (method === "POST") {
          envPosts++
          const status =
            envPosts === 1 && overrides.firstEnvStatus
              ? overrides.firstEnvStatus
              : (overrides.envStatus ?? 201)
          return new Response(JSON.stringify({ message: status === 409 ? "exists" : "ok" }), {
            status,
          })
        }
        return new Response("{}", { status: overrides.envStatus ?? 200 })
      }
      if (u.includes("/deploy?uuid=app-live")) {
        return new Response(JSON.stringify({ deployments: [{ deployment_uuid: "d1" }] }), {
          status: overrides.deployStatus ?? 200,
        })
      }
      return new Response("{}", { status: 404 })
    })
    return calls
  }

  it("skips an app that has no Coolify application, and touches nothing for it", async () => {
    const calls = fakeCoolify()
    const outcomes = await refreshFleet(HASH, [apps[1] as FleetApp], coolify, () => {})
    expect(outcomes[0]?.outcome).toBe("skipped")
    expect(calls.every((c) => c.method === "GET")).toBe(true)
  })

  it("sets the hash and redeploys: updated", async () => {
    const calls = fakeCoolify()
    const outcomes = await refreshFleet(HASH, [apps[0] as FleetApp], coolify, () => {})
    expect(outcomes[0]?.outcome).toBe("updated")
    expect(calls.some((c) => c.method === "POST" && c.url.includes("/deploy?uuid=app-live"))).toBe(
      true,
    )
  })

  it("reports env-only when the variable landed but the redeploy did not", async () => {
    // The distinction that matters: the new password is stored but not yet in
    // force, and saying "updated" here would be a lie.
    fakeCoolify({ deployStatus: 500 })
    const outcomes = await refreshFleet(HASH, [apps[0] as FleetApp], coolify, () => {})
    expect(outcomes[0]?.outcome).toBe("env-only")
    expect(outcomes[0]?.detail).toContain("redeploy")
  })

  it("reports failed when Coolify refuses the variable", async () => {
    fakeCoolify({ envStatus: 422 })
    const outcomes = await refreshFleet(HASH, [apps[0] as FleetApp], coolify, () => {})
    expect(outcomes[0]?.outcome).toBe("failed")
  })

  it("sends the hash as a literal production value, and updates it in place when it exists", async () => {
    // A scrypt hash is full of `$`; anything but a literal value mangles it.
    // An existing entry is PATCHed, not duplicated, so one value stays in force.
    const calls = fakeCoolify({ firstEnvStatus: 409 })
    await refreshFleet(HASH, [apps[0] as FleetApp], coolify, () => {})
    const envCalls = calls.filter((c) => c.url.includes("/applications/app-live/envs"))
    expect(envCalls.map((c) => c.method)).toEqual(["POST", "PATCH"])
    const sent = JSON.parse(envCalls[1]?.body ?? "{}")
    expect(sent).toMatchObject({
      key: "WERFT_PASSWORD_HASH",
      value: HASH,
      is_literal: true,
      is_preview: false,
    })
  })
})
