import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * The slice of the Vercel REST API this needs: read and set a project's root
 * directory.
 *
 * `vercel link` cannot set it, and it has to be set before the first deploy.
 * Without it Vercel builds a monorepo from the repository root and then looks
 * for output there, which for an app in apps/web means the build succeeds and
 * the deploy fails.
 *
 * Uses global fetch, as the Neon calls do — one more endpoint does not justify
 * a dependency.
 */

const VERCEL_API = "https://api.vercel.com"

/** Where the CLI keeps its credential, per platform. */
const CLI_AUTH_PATHS = [
  ["Library", "Application Support", "com.vercel.cli", "auth.json"], // macOS
  [".local", "share", "com.vercel.cli", "auth.json"], // Linux
  ["AppData", "Roaming", "com.vercel.cli", "auth.json"], // Windows
]

export type TokenSource = "~/.config/werft/vercel-token" | "VERCEL_TOKEN" | "vercel CLI"

export type VercelToken = {
  token: string
  source: TokenSource
}

export type LinkedProject = {
  projectId: string
  orgId: string
}

/**
 * Durable credentials first, the CLI's own last.
 *
 * The order is a lesson paid for in a real outage: the CLI's auth.json token
 * rotates roughly daily (expiresAt ~24h out), and a VERCEL_TOKEN repo secret
 * copied from it went invalid the same afternoon — every CI job that needed
 * Vercel started 403ing with invalidToken. A long-lived access token minted
 * at vercel.com/account/tokens and kept in ~/.config/werft/vercel-token
 * doesn't rot; VERCEL_TOKEN in the environment is how CI runners inject
 * theirs; the CLI credential remains the zero-setup fallback for interactive
 * use, where daily rotation doesn't matter.
 */
export async function resolveVercelToken(
  now: number = Date.now(),
  durableTokenPath: string = join(homedir(), ".config", "werft", "vercel-token"),
): Promise<VercelToken | null> {
  const durable = (await readFile(durableTokenPath, "utf8").catch(() => "")).trim()
  if (durable !== "") return { token: durable, source: "~/.config/werft/vercel-token" }

  const fromEnv = process.env.VERCEL_TOKEN
  if (fromEnv) return { token: fromEnv, source: "VERCEL_TOKEN" }

  for (const segments of CLI_AUTH_PATHS) {
    const path = join(homedir(), ...segments)
    let parsed: { token?: unknown; expiresAt?: unknown }
    try {
      parsed = JSON.parse(await readFile(path, "utf8")) as typeof parsed
    } catch {
      continue
    }

    const expiry = normaliseExpiry(parsed.expiresAt)
    const expired = expiry !== undefined && expiry <= now
    if (typeof parsed.token === "string" && parsed.token !== "" && !expired) {
      return { token: parsed.token, source: "vercel CLI" }
    }
  }

  return null
}

/**
 * Returns the expiry in milliseconds, whatever unit it was written in.
 *
 * The CLI writes seconds. Comparing that against Date.now() in milliseconds
 * makes every token look long expired, which silently discards a perfectly good
 * credential — so the unit is inferred rather than assumed. Any plausible
 * millisecond timestamp is far above 1e12; any second timestamp is far below.
 */
export function normaliseExpiry(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined
  return value < 1e12 ? value * 1000 : value
}

/** Reads what `vercel link` wrote, which identifies the project unambiguously. */
export async function readLinkedProject(dir: string): Promise<LinkedProject | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, ".vercel", "project.json"), "utf8")) as {
      projectId?: unknown
      orgId?: unknown
    }
    if (typeof parsed.projectId === "string" && typeof parsed.orgId === "string") {
      return { projectId: parsed.projectId, orgId: parsed.orgId }
    }
  } catch {
    // fall through
  }
  return null
}

/**
 * Team-scoped projects need the team on the query string; personal ones must
 * not have it. The orgId prefix is what distinguishes them.
 */
function scoped(path: string, project: LinkedProject): string {
  const url = `${VERCEL_API}${path}`
  return project.orgId.startsWith("team_")
    ? `${url}${url.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(project.orgId)}`
    : url
}

/**
 * Pulls the deployment URL out of `vercel deploy` output.
 *
 * Stops at quotes, commas and angle brackets as well as whitespace: the CLI
 * prints the URL inside JSON-ish context, and a greedy match swallowed the
 * closing `",` and wrote a malformed URL into werft.json.
 *
 * Kept for diagnostics — what the scaffold actually records is
 * `stableAliasUrl`, below. This URL is a specific deployment's, and Vercel
 * deployments are immutable: the next deploy leaves it pointing at a stale
 * snapshot rather than at whatever is currently live.
 */
export function extractDeployUrl(output: string): string {
  return /https:\/\/[^\s"'<>,)\]]+/.exec(output)?.[0] ?? ""
}

/**
 * The stable alias Vercel assigns every project at creation, which every
 * production deploy promotes to — confirmed against two real projects, both
 * serving `https://<project-name>.vercel.app` from their Aliases list.
 *
 * `name` is already constrained by NAME_PATTERN to lowercase letters, digits
 * and hyphens, which is exactly a valid subdomain — no transformation needed.
 */
export function stableAliasUrl(name: string): string {
  return `https://${name}.vercel.app`
}

/**
 * Vercel SSO in front of the whole deployment.
 *
 * Applied to every new project as a team-level default, and cleared per
 * project — verified: a bare project is created with it on, PATCHing null takes
 * effect, and it does not reassert on re-read.
 */
export type SsoProtection = { deploymentType: string } | null

export const SSO_ENABLED: SsoProtection = { deploymentType: "all_except_custom_domains" }

export type ProjectSettings = {
  rootDirectory: string | null
  framework: string | null
  ssoProtection: SsoProtection
}

/**
 * Both settings matter, and neither is set by `vercel link`.
 *
 * rootDirectory tells Vercel the app is in apps/web, so it installs at the
 * workspace root and builds in the app. framework tells it the output is a
 * Next.js build rather than a static directory — without it, Vercel looks for
 * `public/` after a perfectly successful build and fails the deploy.
 */
export async function updateProjectSettings(
  project: LinkedProject,
  token: string,
  settings: Partial<ProjectSettings>,
): Promise<void> {
  const response = await fetch(scoped(`/v9/projects/${project.projectId}`, project), {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(settings),
  })

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { message?: unknown }
    } | null
    const detail =
      typeof body?.error?.message === "string" ? body.error.message : response.statusText
    throw new Error(`Vercel refused the project settings (${response.status}): ${detail}`)
  }
}

/** Reads them back, so the settings are confirmed rather than assumed. */
export async function getProjectSettings(
  project: LinkedProject,
  token: string,
): Promise<ProjectSettings | null> {
  const response = await fetch(scoped(`/v9/projects/${project.projectId}`, project), {
    headers: { Authorization: `Bearer ${token}` },
  })

  if (!response.ok) return null

  const body = (await response.json().catch(() => null)) as {
    rootDirectory?: unknown
    framework?: unknown
    ssoProtection?: unknown
  } | null

  const sso = body?.ssoProtection
  const deploymentType =
    typeof sso === "object" && sso !== null
      ? (sso as { deploymentType?: unknown }).deploymentType
      : undefined

  return {
    rootDirectory: typeof body?.rootDirectory === "string" ? body.rootDirectory : null,
    framework: typeof body?.framework === "string" ? body.framework : null,
    ssoProtection: typeof deploymentType === "string" ? { deploymentType } : null,
  }
}
