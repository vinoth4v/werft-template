import { afterEach, describe, expect, it, vi } from "vitest"
import { neonDeleteCommand, verifyNeonApiKey } from "./neon.ts"

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) =>
    handler(String(url), init),
  )
}

describe("verifyNeonApiKey", () => {
  it("accepts a key Neon accepts", async () => {
    stubFetch(() => new Response("{}", { status: 200 }))
    expect(await verifyNeonApiKey("napi_good")).toBe("ok")
  })

  it("reports a rejected key as rejected", async () => {
    for (const status of [401, 403]) {
      stubFetch(() => new Response("{}", { status }))
      expect(await verifyNeonApiKey("placeholder"), String(status)).toBe("rejected")
    }
  })

  it("does not blame the key for a server-side failure", async () => {
    // A 500 or a rate limit is not evidence the credential is wrong.
    for (const status of [429, 500, 503]) {
      stubFetch(() => new Response("{}", { status }))
      expect(await verifyNeonApiKey("napi_good"), String(status)).toBe("unreachable")
    }
  })

  it("reports unreachable when the request throws", async () => {
    stubFetch(() => {
      throw new Error("offline")
    })
    expect(await verifyNeonApiKey("napi_good")).toBe("unreachable")
  })

  it("sends the key as a bearer header, never in the URL", async () => {
    let seenUrl = ""
    let seenAuth: string | undefined
    stubFetch((url, init) => {
      seenUrl = url
      seenAuth = (init?.headers as Record<string, string> | undefined)?.Authorization
      return new Response("{}", { status: 200 })
    })

    await verifyNeonApiKey("napi_super_secret")

    expect(seenUrl).not.toContain("napi_super_secret")
    expect(seenAuth).toBe("Bearer napi_super_secret")
  })
})

describe("neonDeleteCommand", () => {
  it("refers to the environment variable rather than embedding the key", () => {
    const command = neonDeleteCommand("br-example-123")

    expect(command).toContain("$NEON_API_KEY")
    expect(command).toContain("br-example-123")
  })
})
