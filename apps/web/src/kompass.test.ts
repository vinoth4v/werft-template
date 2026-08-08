import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const BASE = "https://kompass.example.workers.dev"

// Imported fresh in each test: the module caches its configuration on first
// use, exactly as env.ts does, so a stale cache would leak between cases.
async function load() {
  vi.resetModules()
  return import("./kompass.ts")
}

function reply(text: string, headers: Record<string, string> = {}) {
  return new Response(
    JSON.stringify({
      content: [{ type: "text", text }],
      usage: { input_tokens: 11, output_tokens: 7 },
    }),
    { status: 200, headers },
  )
}

beforeEach(() => {
  vi.stubEnv("KOMPASS_BASE_URL", BASE)
  vi.stubEnv("KOMPASS_TOKEN", "tok")
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("ask", () => {
  it("defaults to the agentic lane", async () => {
    let sent: Record<string, unknown> = {}
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body))
      return reply("hello")
    })

    const { ask } = await load()
    await ask([{ role: "user", content: "hi" }])

    expect(sent.model).toBe("kompass-agentic")
    expect(sent.max_tokens).toBe(1024)
    // No system block unless asked for: sending an empty one changes behaviour.
    expect("system" in sent).toBe(false)
  })

  it("posts to /v1/messages with the token in the header, never the URL", async () => {
    let url = ""
    let auth = ""
    vi.stubGlobal("fetch", async (u: string, init?: RequestInit) => {
      url = String(u)
      auth = ((init?.headers ?? {}) as Record<string, string>).Authorization ?? ""
      return reply("ok")
    })

    const { askOnce } = await load()
    await askOnce("hi")

    expect(url).toBe(`${BASE}/v1/messages`)
    expect(url).not.toContain("tok")
    expect(auth).toBe("Bearer tok")
  })

  it("does not double the slash when the base URL has a trailing one", async () => {
    vi.stubEnv("KOMPASS_BASE_URL", `${BASE}/`)
    let url = ""
    vi.stubGlobal("fetch", async (u: string) => {
      url = String(u)
      return reply("ok")
    })

    const { askOnce } = await load()
    await askOnce("hi")
    expect(url).toBe(`${BASE}/v1/messages`)
  })

  it("reports which lane and model answered, for diagnosing a poor reply", async () => {
    vi.stubGlobal("fetch", async () =>
      reply("hi", {
        "x-kompass-lane": "AGENTIC",
        "x-kompass-served-by": "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
      }),
    )

    const { ask } = await load()
    const answer = await ask([{ role: "user", content: "hi" }])

    expect(answer.lane).toBe("AGENTIC")
    expect(answer.servedBy).toContain("nemotron")
    expect(answer.inputTokens).toBe(11)
    expect(answer.outputTokens).toBe(7)
  })

  it("joins multiple text blocks rather than returning only the first", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            content: [
              { type: "text", text: "one " },
              { type: "text", text: "two" },
            ],
          }),
          { status: 200 },
        ),
    )

    const { askOnce } = await load()
    expect(await askOnce("hi")).toBe("one two")
  })

  it("surfaces the gateway's status, because 429 and 401 mean different things", async () => {
    vi.stubGlobal("fetch", async () => new Response("every lane busy", { status: 429 }))
    const { askOnce } = await load()
    await expect(askOnce("hi")).rejects.toThrow("429")
  })

  it("names both variables when it is not configured, instead of failing at the gateway", async () => {
    vi.stubEnv("KOMPASS_TOKEN", "")
    vi.stubGlobal("fetch", async () => reply("never reached"))

    const { askOnce } = await load()
    await expect(askOnce("hi")).rejects.toThrow(/KOMPASS_TOKEN.*\.env\.example/s)
  })

  it("reads the environment lazily, so importing it cannot break `next build`", async () => {
    vi.unstubAllEnvs()
    // Importing with nothing configured must not throw — only calling does.
    const mod = await load()
    expect(typeof mod.ask).toBe("function")
  })
})
