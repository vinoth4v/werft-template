/**
 * The werft.json contract.
 *
 * Every app carries one, and CI reads it on merge to upsert the registry row.
 * The registry is populated by CI only, so this file is the single place an app
 * describes itself.
 *
 * It is committed to a repo that may be public. Nothing secret goes in it —
 * no connection strings, no tokens, no API keys.
 */

export const APP_STATUSES = ["prototype", "active", "paused", "archived"] as const

export type AppStatus = (typeof APP_STATUSES)[number]

export type WerftJson = {
  name: string
  /**
   * How the app brands itself, for display only — "SruthiScribe Learn" rather
   * than the `sruthiscribe-learn` slug `name` is forced to be by doubling as a
   * repo, database and subdomain. Optional; without it the slug is displayed.
   */
  title?: string
  description: string
  stack: string[]
  url: string
  tags: string[]
  status: AppStatus
  private: boolean
}

/** Doubles as the GitHub repo, Neon project, and Vercel project name. */
export const NAME_PATTERN = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/

const KEY_ORDER = [
  "name",
  "title",
  "description",
  "stack",
  "url",
  "tags",
  "status",
  "private",
] as const satisfies readonly (keyof WerftJson)[]

/**
 * Key names that must never appear, whatever the value.
 *
 * A secret in werft.json would be committed and, for a public repo, published.
 * Rejecting the key outright is cheaper than reviewing every value.
 */
const FORBIDDEN_KEYS = ["secret", "token", "password", "apikey", "api_key", "key", "credentials"]

/** Returns a list of problems. Empty means valid. */
export function validateWerftJson(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["must be a JSON object"]
  }

  const record = value as Record<string, unknown>
  const problems: string[] = []

  if (typeof record.name !== "string" || !NAME_PATTERN.test(record.name)) {
    problems.push("name must be lowercase letters, digits and hyphens, 2-40 characters")
  }

  if (typeof record.description !== "string" || record.description.trim() === "") {
    problems.push("description must be a non-empty string")
  }

  // Optional, but a present-and-empty title would render a blank heading,
  // which is worse than falling back to the slug.
  if (record.title !== undefined) {
    if (typeof record.title !== "string" || record.title.trim() === "") {
      problems.push("title must be a non-empty string when present")
    } else if (record.title.length > 60) {
      problems.push("title must be 60 characters or fewer")
    }
  }

  if (typeof record.url !== "string") {
    problems.push("url must be a string (empty until the app is deployed)")
  } else if (record.url !== "" && !/^https:\/\//.test(record.url)) {
    problems.push("url must be empty or an https URL")
  }

  for (const field of ["stack", "tags"] as const) {
    const list = record[field]
    if (!Array.isArray(list) || list.some((entry) => typeof entry !== "string" || entry === "")) {
      problems.push(`${field} must be an array of non-empty strings`)
    }
  }

  if (typeof record.status !== "string" || !APP_STATUSES.includes(record.status as AppStatus)) {
    problems.push(`status must be one of: ${APP_STATUSES.join(", ")}`)
  }

  if (typeof record.private !== "boolean") {
    problems.push("private must be a boolean")
  }

  for (const key of Object.keys(record)) {
    if (!(KEY_ORDER as readonly string[]).includes(key)) {
      problems.push(`unknown key "${key}" — the registry ignores it, so it does not belong here`)
    }
    if (FORBIDDEN_KEYS.includes(key.toLowerCase().replaceAll("-", "_"))) {
      problems.push(`key "${key}" looks like a secret; werft.json is committed and may be public`)
    }
  }

  return problems
}

/** Serialises with a stable key order, so diffs stay readable. */
export function renderWerftJson(app: WerftJson): string {
  const ordered: Record<string, unknown> = {}
  for (const key of KEY_ORDER) {
    ordered[key] = app[key]
  }

  return `${JSON.stringify(ordered, null, 2)}\n`
}
