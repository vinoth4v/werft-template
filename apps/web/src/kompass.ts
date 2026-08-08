import { z } from "zod"

/**
 * The app's way to reach a model.
 *
 * Every Werft app that needs AI at runtime calls through here, and nothing
 * calls a provider directly. That is not ceremony: the gateway owns lane
 * selection, quota and cooldown across a chain of models per lane, so a
 * provider being rate-limited becomes a slightly different answer instead of a
 * 429 in front of a user. Reimplementing that client-side would mean
 * reimplementing all of it badly.
 *
 * The default lane is `kompass-agentic` — the one built for tool-using,
 * multi-step work, which is what an app feature normally needs. `kompass-fast`
 * is there for short, latency-sensitive calls and `kompass-hard` for the rare
 * request worth waiting on. Lane names are aliases: the gateway decides which
 * concrete model serves each one, and the app is deliberately not told.
 *
 * Server-side only. The token is a secret; a browser must never see it, so a
 * feature that needs a model calls a route handler or server action that calls
 * this.
 */

export const LANES = [
  "kompass-agentic",
  "kompass-fast",
  "kompass-simple",
  "kompass-hard",
  "kompass-longctx",
] as const

export type Lane = (typeof LANES)[number]

const configSchema = z.object({
  KOMPASS_BASE_URL: z.url(),
  KOMPASS_TOKEN: z.string().min(1),
})

let cached: z.infer<typeof configSchema> | undefined

/**
 * Read on first use, never at module scope — `next build` has to work without
 * any of this, and an app that never calls a model should never need it set.
 *
 * The error names the two variables and points at .env.example, because the
 * failure otherwise surfaces as an unauthorised gateway response and sends you
 * looking at the gateway.
 */
function config(): z.infer<typeof configSchema> {
  if (cached) return cached

  const parsed = configSchema.safeParse(process.env)
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join(".")} (${issue.message})`)
      .join(", ")
    throw new Error(
      `Kompass is not configured: ${problems}. Set KOMPASS_BASE_URL and KOMPASS_TOKEN — see .env.example.`,
    )
  }

  cached = parsed.data
  return cached
}

export type Message = { role: "user" | "assistant"; content: string }

export type AskOptions = {
  /** Defaults to the agentic lane. */
  lane?: Lane
  /** Hard cap on the reply. Required by the API, so it has a sane default. */
  maxTokens?: number
  system?: string
  /** Abort signal, so a request cannot outlive the response it belongs to. */
  signal?: AbortSignal
}

export type Answer = {
  text: string
  /** The lane that answered, from the gateway's own header — useful when a
   * response is worse than expected, because it says which lane produced it. */
  lane: string
  /** Which concrete model served it. Reported for diagnosis, never branched on:
   * the point of the gateway is that this can change under you. */
  servedBy: string
  inputTokens: number
  outputTokens: number
}

/**
 * Sends messages to the gateway and returns the reply as text.
 *
 * Anthropic's message shape, which is what the gateway speaks — and what makes
 * `@anthropic-ai/sdk` unnecessary rather than merely discouraged: this is one
 * fetch and a schema.
 */
export async function ask(messages: readonly Message[], options: AskOptions = {}): Promise<Answer> {
  const { KOMPASS_BASE_URL, KOMPASS_TOKEN } = config()

  const response = await fetch(`${KOMPASS_BASE_URL.replace(/\/$/, "")}/v1/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${KOMPASS_TOKEN}`,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: options.lane ?? "kompass-agentic",
      max_tokens: options.maxTokens ?? 1024,
      ...(options.system ? { system: options.system } : {}),
      messages,
    }),
    signal: options.signal,
  })

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300)
    // The status matters to the caller: 429 means every model in the lane is
    // busy and retrying later is reasonable, while 401 means the token is wrong
    // and retrying is pointless.
    throw new Error(`Kompass answered ${response.status}: ${detail}`)
  }

  const body = (await response.json().catch(() => null)) as {
    content?: { type?: string; text?: string }[]
    usage?: { input_tokens?: number; output_tokens?: number }
  } | null

  const text = (body?.content ?? [])
    .filter((block) => block.type === "text" || typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("")

  return {
    text,
    lane: response.headers.get("x-kompass-lane") ?? "",
    servedBy: response.headers.get("x-kompass-served-by") ?? "",
    inputTokens: body?.usage?.input_tokens ?? 0,
    outputTokens: body?.usage?.output_tokens ?? 0,
  }
}

/** The common case: one question, one answer. */
export async function askOnce(prompt: string, options: AskOptions = {}): Promise<string> {
  const answer = await ask([{ role: "user", content: prompt }], options)
  return answer.text
}
