import { afterEach, describe, expect, it, vi } from "vitest"
import { getRootDirectory, type LinkedProject, setRootDirectory } from "./vercel.ts"

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

const team: LinkedProject = { projectId: "prj_abc", orgId: "team_xyz" }
const personal: LinkedProject = { projectId: "prj_abc", orgId: "user_xyz" }

describe("setRootDirectory", () => {
  it("PATCHes the project with the root directory", async () => {
    const seen: Seen[] = []
    stubFetch(200, {}, seen)

    await setRootDirectory(team, "tok", "apps/web")

    expect(seen[0]?.method).toBe("PATCH")
    expect(seen[0]?.url).toContain("/v9/projects/prj_abc")
    expect(JSON.parse(seen[0]?.body ?? "{}")).toEqual({ rootDirectory: "apps/web" })
  })

  it("scopes the request to the team when the project belongs to one", async () => {
    const seen: Seen[] = []
    stubFetch(200, {}, seen)

    await setRootDirectory(team, "tok", "apps/web")

    expect(seen[0]?.url).toContain("teamId=team_xyz")
  })

  it("omits the team for a personal project, where it would be wrong", async () => {
    const seen: Seen[] = []
    stubFetch(200, {}, seen)

    await setRootDirectory(personal, "tok", "apps/web")

    expect(seen[0]?.url).not.toContain("teamId")
  })

  it("throws with the reason Vercel gave", async () => {
    stubFetch(403, { error: { message: "not authorized" } }, [])

    await expect(setRootDirectory(team, "tok", "apps/web")).rejects.toThrow("not authorized")
  })

  it("never puts the token in the URL", async () => {
    const seen: Seen[] = []
    stubFetch(200, {}, seen)

    await setRootDirectory(team, "super-secret-token", "apps/web")

    expect(seen[0]?.url).not.toContain("super-secret-token")
  })
})

describe("getRootDirectory", () => {
  it("reads the setting back", async () => {
    stubFetch(200, { rootDirectory: "apps/web" }, [])
    expect(await getRootDirectory(team, "tok")).toBe("apps/web")
  })

  it("returns null when unset, so an unset value is never mistaken for a match", async () => {
    stubFetch(200, { rootDirectory: null }, [])
    expect(await getRootDirectory(team, "tok")).toBeNull()
  })

  it("returns null when the request fails", async () => {
    stubFetch(500, {}, [])
    expect(await getRootDirectory(team, "tok")).toBeNull()
  })
})
