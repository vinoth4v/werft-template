import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
  extractDeployUrl,
  getProjectSettings,
  type LinkedProject,
  normaliseExpiry,
  readLinkedProject,
  SSO_ENABLED,
  stableAliasUrl,
  updateProjectSettings,
} from "./vercel.ts"

afterEach(() => {
  vi.unstubAllGlobals()
})

type Seen = { url: string; method: string | undefined; body: string | undefined }

function stubFetch(status: number, payload: unknown, seen: Seen[]) {
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    seen.push({
      url: String(url),
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
    })
    return new Response(JSON.stringify(payload), { status })
  })
}

const SETTINGS = { rootDirectory: "apps/web", framework: "nextjs", ssoProtection: null } as const

const team: LinkedProject = { projectId: "prj_abc", orgId: "team_xyz" }
const personal: LinkedProject = { projectId: "prj_abc", orgId: "user_xyz" }

describe("updateProjectSettings", () => {
  it("PATCHes both the root directory and the framework", async () => {
    const seen: Seen[] = []
    stubFetch(200, {}, seen)

    await updateProjectSettings(team, "tok", SETTINGS)

    expect(seen[0]?.method).toBe("PATCH")
    expect(seen[0]?.url).toContain("/v9/projects/prj_abc")
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual(SETTINGS)
  })

  it("scopes the request to the team when the project belongs to one", async () => {
    const seen: Seen[] = []
    stubFetch(200, {}, seen)

    await updateProjectSettings(team, "tok", SETTINGS)

    expect(seen[0]?.url).toContain("teamId=team_xyz")
  })

  it("omits the team for a personal project, where it would be wrong", async () => {
    const seen: Seen[] = []
    stubFetch(200, {}, seen)

    await updateProjectSettings(personal, "tok", SETTINGS)

    expect(seen[0]?.url).not.toContain("teamId")
  })

  it("throws with the reason Vercel gave", async () => {
    stubFetch(403, { error: { message: "not authorized" } }, [])

    await expect(updateProjectSettings(team, "tok", SETTINGS)).rejects.toThrow("not authorized")
  })

  it("never puts the token in the URL", async () => {
    const seen: Seen[] = []
    stubFetch(200, {}, seen)

    await updateProjectSettings(team, "super-secret-token", SETTINGS)

    expect(seen[0]?.url).not.toContain("super-secret-token")
  })
})

describe("extractDeployUrl", () => {
  it("stops at the closing quote and comma", () => {
    // The regression: a greedy match wrote
    // https://werft-test-4-....vercel.app", into werft.json.
    const output = '  Production      https://werft-test-4-abc-vinoth4vs-projects.vercel.app",\n'

    expect(extractDeployUrl(output)).toBe("https://werft-test-4-abc-vinoth4vs-projects.vercel.app")
  })

  it("produces something that parses as a URL", () => {
    const extracted = extractDeployUrl('x https://example.vercel.app", y')
    expect(() => new URL(extracted)).not.toThrow()
    expect(new URL(extracted).hostname).toBe("example.vercel.app")
  })

  it("takes the first URL from multi-line output", () => {
    const output = [
      "  Inspect         https://vercel.com/team/proj/abc123",
      "  Production      https://proj.vercel.app",
    ].join("\n")

    expect(extractDeployUrl(output)).toBe("https://vercel.com/team/proj/abc123")
  })

  it("returns empty when there is no URL, rather than a fragment", () => {
    expect(extractDeployUrl("Error: build failed")).toBe("")
  })
})

describe("stableAliasUrl", () => {
  it("matches the alias Vercel actually assigns a project", () => {
    // Confirmed against two real projects (werft-test-4, werft-marketplace):
    // both serve https://<project-name>.vercel.app from their Aliases list.
    expect(stableAliasUrl("werft-marketplace")).toBe("https://werft-marketplace.vercel.app")
  })

  it("needs no escaping for a name — NAME_PATTERN already guarantees valid subdomain characters", () => {
    expect(stableAliasUrl("my-app-2")).toBe("https://my-app-2.vercel.app")
  })
})

describe("normaliseExpiry", () => {
  it("treats a seconds timestamp as seconds", () => {
    // The regression: the CLI writes seconds, this was compared against a
    // millisecond clock, so a working credential looked decades expired and a
    // real provisioning run failed on "no Vercel API token".
    const seconds = 1_786_000_000
    expect(normaliseExpiry(seconds)).toBe(seconds * 1000)
  })

  it("leaves a milliseconds timestamp alone", () => {
    const millis = 1_786_000_000_000
    expect(normaliseExpiry(millis)).toBe(millis)
  })

  it("puts a seconds expiry in the future, not the distant past", () => {
    const anHourFromNowInSeconds = Math.floor(Date.now() / 1000) + 3600
    expect(normaliseExpiry(anHourFromNowInSeconds)).toBeGreaterThan(Date.now())
  })

  it("has no opinion when there is no usable value", () => {
    for (const value of [undefined, null, 0, -1, "soon", Number.NaN]) {
      expect(normaliseExpiry(value), String(value)).toBeUndefined()
    }
  })
})

describe("resolveVercelToken", () => {
  it("prefers the durable operator token over everything", async () => {
    // The order is the fix for a real outage: a secret copied from the CLI's
    // rotating credential died the same afternoon. Durable file wins.
    const dir = await mkdtemp(join(tmpdir(), "werft-vtok-"))
    const durablePath = join(dir, "vercel-token")
    await writeFile(durablePath, "durable-long-lived-token\n")

    const { resolveVercelToken } = await import("./vercel.ts")
    const resolved = await resolveVercelToken(Date.now(), durablePath)

    expect(resolved).toEqual({
      token: "durable-long-lived-token",
      source: "~/.config/werft/vercel-token",
    })
  })

  it("falls past a missing durable file without failing", async () => {
    const { resolveVercelToken } = await import("./vercel.ts")
    const resolved = await resolveVercelToken(
      Date.now(),
      join(tmpdir(), "definitely-absent", "vercel-token"),
    )

    // Whatever it found next (env or the machine's real CLI auth), the point
    // is it kept looking rather than returning null on ENOENT.
    expect(resolved === null || resolved.source !== "~/.config/werft/vercel-token").toBe(true)
  })
})

describe("readLinkedProject", () => {
  it("reads the projectId and orgId vercel link wrote", async () => {
    const dir = await mkdtemp(join(tmpdir(), "werft-link-"))
    await mkdir(join(dir, ".vercel"), { recursive: true })
    await writeFile(
      join(dir, ".vercel", "project.json"),
      JSON.stringify({ projectId: "prj_1", orgId: "team_1", extra: "ignored" }),
    )

    expect(await readLinkedProject(dir)).toEqual({ projectId: "prj_1", orgId: "team_1" })
  })

  it("returns null when the link is missing or incomplete", async () => {
    const dir = await mkdtemp(join(tmpdir(), "werft-link-"))
    expect(await readLinkedProject(dir)).toBeNull()

    await mkdir(join(dir, ".vercel"), { recursive: true })
    await writeFile(join(dir, ".vercel", "project.json"), JSON.stringify({ projectId: "prj_1" }))
    expect(await readLinkedProject(dir)).toBeNull()
  })
})

describe("getProjectSettings", () => {
  it("reads the setting back", async () => {
    stubFetch(
      200,
      {
        rootDirectory: "apps/web",
        framework: "nextjs",
        ssoProtection: null,
        serverlessFunctionRegion: "fra1",
      },
      [],
    )
    expect(await getProjectSettings(team, "tok")).toEqual({
      rootDirectory: "apps/web",
      framework: "nextjs",
      ssoProtection: null,
      serverlessFunctionRegion: "fra1",
    })
  })

  it("returns null when unset, so an unset value is never mistaken for a match", async () => {
    // An unset framework is exactly the state that failed two real deploys.
    stubFetch(200, { rootDirectory: null, framework: null, ssoProtection: null }, [])
    expect(await getProjectSettings(team, "tok")).toEqual({
      rootDirectory: null,
      framework: null,
      ssoProtection: null,
      serverlessFunctionRegion: null,
    })
  })

  it("returns null when the request fails", async () => {
    stubFetch(500, {}, [])
    expect(await getProjectSettings(team, "tok")).toBeNull()
  })
})

describe("ssoProtection parsing", () => {
  it("reads the team default Vercel applies to new projects", async () => {
    stubFetch(200, { ssoProtection: { deploymentType: "all_except_custom_domains" } }, [])

    const settings = await getProjectSettings(team, "tok")

    expect(settings?.ssoProtection).toEqual({ deploymentType: "all_except_custom_domains" })
  })

  it("reads a cleared protection as null, so off is distinguishable from on", async () => {
    stubFetch(200, { ssoProtection: null }, [])
    expect((await getProjectSettings(team, "tok"))?.ssoProtection).toBeNull()
  })

  it("sends null to clear it, which is what turns SSO off", async () => {
    const seen: Seen[] = []
    stubFetch(200, {}, seen)

    await updateProjectSettings(team, "tok", { ssoProtection: null })

    expect(seen[0]?.body).toContain('"ssoProtection":null')
  })

  it("sends the deployment type to enable it", async () => {
    const seen: Seen[] = []
    stubFetch(200, {}, seen)

    await updateProjectSettings(team, "tok", { ssoProtection: SSO_ENABLED })

    expect(JSON.parse(seen[0]?.body ?? "{}").ssoProtection).toEqual(SSO_ENABLED)
  })
})
