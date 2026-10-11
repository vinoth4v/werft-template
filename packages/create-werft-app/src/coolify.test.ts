import { afterEach, describe, expect, it, vi } from "vitest"
import {
  appDomain,
  coolifyFromEnv,
  createCoolifyApp,
  deleteCoolifyApp,
  setCoolifyEnv,
  verifyCoolify,
} from "./coolify.ts"

const auth = { base: "http://coolify.test/api/v1", token: "tok" }

afterEach(() => {
  vi.unstubAllGlobals()
})

type Route = (method: string, url: string, body: unknown) => Response | undefined
function stubCoolify(route: Route) {
  const calls: { method: string; url: string; body: unknown }[] = []
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET"
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
    calls.push({ method, url: String(url), body })
    return route(method, String(url), body) ?? new Response("{}", { status: 404 })
  })
  return calls
}

/** The lookups createCoolifyApp makes before creating anything. */
const placement: Route = (method, url) => {
  if (method !== "GET") return undefined
  if (url.endsWith("/applications")) return Response.json([])
  if (url.endsWith("/servers")) return Response.json([{ uuid: "srv", is_coolify_host: true }])
  if (url.endsWith("/github-apps"))
    return Response.json([{ uuid: "public" }, { uuid: "gh", app_id: 42 }])
  if (url.endsWith("/projects")) return Response.json([{ uuid: "prj", name: "Apps" }])
  if (url.endsWith("/projects/prj"))
    return Response.json({ environments: [{ uuid: "env", name: "production" }] })
  return undefined
}

describe("coolifyFromEnv", () => {
  it("needs both the URL and the token", () => {
    expect(coolifyFromEnv({ COOLIFY_API_URL: "http://c/api/v1/" })).toBeNull()
    expect(coolifyFromEnv({ COOLIFY_API_URL: "http://c/api/v1/", COOLIFY_API_TOKEN: "t" })).toEqual(
      { base: "http://c/api/v1", token: "t" },
    )
  })
})

describe("appDomain", () => {
  it("is <name>.vinothkannan.de unless WERFT_DOMAIN says otherwise", () => {
    expect(appDomain("toli", {})).toBe("toli.vinothkannan.de")
    expect(appDomain("toli", { WERFT_DOMAIN: "example.org" })).toBe("toli.example.org")
  })
})

describe("verifyCoolify", () => {
  it("is ok when the API answers, even though /version is plain text, not JSON", async () => {
    stubCoolify(() => new Response("4.4.6", { status: 200 }))
    expect(await verifyCoolify(auth)).toBe("ok")
  })

  it("separates a rejected token from an unreachable API", async () => {
    stubCoolify(() => new Response("{}", { status: 401 }))
    expect(await verifyCoolify(auth)).toBe("rejected")
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED")
    })
    expect(await verifyCoolify(auth)).toBe("unreachable")
  })
})

describe("createCoolifyApp", () => {
  it("creates a Dockerfile app with previews, the commit passed to the build, and plain-http domain behind Cloudflare", async () => {
    const calls = stubCoolify(
      (method, url, body) =>
        placement(method, url, body) ??
        (method === "POST" && url.endsWith("/applications/private-github-app")
          ? Response.json({ uuid: "new" }, { status: 201 })
          : undefined),
    )
    const uuid = await createCoolifyApp(auth, {
      name: "toli",
      repository: "vinoth4v/toli",
      domain: "toli.vinothkannan.de",
    })
    expect(uuid).toBe("new")
    const create = calls.find((c) => c.url.endsWith("/applications/private-github-app"))
    expect(create?.body).toMatchObject({
      github_app_uuid: "gh",
      git_repository: "vinoth4v/toli",
      git_branch: "main",
      build_pack: "dockerfile",
      domains: "http://toli.vinothkannan.de",
      is_preview_deployments_enabled: true,
      preview_url_template: "pr{{pr_id}}-{{domain}}",
      include_source_commit_in_build: true,
      health_check_enabled: false,
      instant_deploy: false,
    })
  })

  it("explains the GitHub App access fix when Coolify cannot see the repository", async () => {
    stubCoolify(
      (method, url, body) =>
        placement(method, url, body) ??
        (method === "POST"
          ? Response.json({ message: "Repository not found" }, { status: 404 })
          : undefined),
    )
    await expect(
      createCoolifyApp(auth, { name: "x", repository: "vinoth4v/x", domain: "x.vinothkannan.de" }),
    ).rejects.toThrow(/all repositories/)
  })

  it("refuses to adopt an application that already exists", async () => {
    stubCoolify((method, url) =>
      method === "GET" && url.endsWith("/applications")
        ? Response.json([{ uuid: "old", name: "toli" }])
        : undefined,
    )
    await expect(
      createCoolifyApp(auth, {
        name: "toli",
        repository: "vinoth4v/toli",
        domain: "toli.vinothkannan.de",
      }),
    ).rejects.toThrow(/already exists/)
  })
})

describe("setCoolifyEnv", () => {
  it("creates the variable as a literal, and patches it when it already exists", async () => {
    const calls = stubCoolify((method) =>
      method === "POST" ? Response.json({ message: "exists" }, { status: 409 }) : Response.json({}),
    )
    await setCoolifyEnv(auth, "app", "WERFT_PASSWORD_HASH", "scrypt$1$2$3$ab$cd")
    expect(calls.map((c) => c.method)).toEqual(["POST", "PATCH"])
    expect(calls[1]?.body).toMatchObject({
      key: "WERFT_PASSWORD_HASH",
      value: "scrypt$1$2$3$ab$cd",
      is_literal: true,
      is_preview: false,
    })
  })

  it("marks preview-only values as such", async () => {
    const calls = stubCoolify(() => Response.json({}, { status: 201 }))
    await setCoolifyEnv(auth, "app", "DATABASE_URL", "postgresql://x/app_preview", {
      preview: true,
    })
    expect(calls[0]?.body).toMatchObject({ is_preview: true })
  })
})

describe("deleteCoolifyApp", () => {
  it("is absent when there is no such application", async () => {
    stubCoolify((method, url) =>
      method === "GET" && url.endsWith("/applications") ? Response.json([]) : undefined,
    )
    expect(await deleteCoolifyApp(auth, "gone")).toBe("absent")
  })
  it("deletes it with its volumes when it exists", async () => {
    const calls = stubCoolify((method, url) =>
      method === "GET" && url.endsWith("/applications")
        ? Response.json([{ uuid: "a1", name: "toli" }])
        : method === "DELETE"
          ? Response.json({})
          : undefined,
    )
    expect(await deleteCoolifyApp(auth, "toli")).toBe("removed")
    expect(
      calls.some(
        (c) =>
          c.method === "DELETE" &&
          c.url.includes("/applications/a1") &&
          c.url.includes("delete_volumes=true"),
      ),
    ).toBe(true)
  })
})
