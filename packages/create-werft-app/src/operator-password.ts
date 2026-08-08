import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { exec } from "./exec.ts"

/**
 * One operator password, for every app Werft has delivered.
 *
 * The single-operator gate means each app holds a password hash in its own
 * environment. Left alone, that means N passwords to remember and no way to
 * change any of them without visiting N dashboards. So the hash is kept once,
 * here, and pushed everywhere:
 *
 *   ~/.config/werft/password-hash   the standing value, read by the scaffold
 *   WERFT_PASSWORD_HASH (secret)    so runner-scaffolded apps get it too
 *   every app's Vercel environment  so apps already delivered accept it
 *
 * What is stored is the scrypt hash, never the password. It is the same value
 * the app itself stores, so keeping it buys an attacker nothing an app's own
 * environment would not, and the plaintext is never written to disk at all.
 *
 * The tradeoff is deliberate and worth naming: one hash across the fleet means
 * one password opens every app, and an environment leak in the weakest app
 * exposes the credential for all of them. That is the operator's stated choice
 * — one standing sign-in — and `create-werft-app --password` still gives a
 * single app its own.
 */

export const HASH_PATH = join(homedir(), ".config", "werft", "password-hash")

export type FleetApp = { name: string; url: string; status: string }

export type AppOutcome = {
  name: string
  /** "updated" means the variable is set *and* a redeploy was started. */
  outcome: "updated" | "env-only" | "skipped" | "failed"
  detail?: string
}

/** A scrypt hash from this template, and nothing else. */
export function looksLikeHash(value: string): boolean {
  return /^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]+\$[0-9a-f]+$/.test(value.trim())
}

/** Stores the standing hash, readable only by its owner. */
export async function writeStandingHash(hash: string, path: string = HASH_PATH): Promise<void> {
  if (!looksLikeHash(hash)) {
    throw new Error("refusing to store something that is not a scrypt hash")
  }
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${hash.trim()}\n`, "utf8")
  await chmod(path, 0o600)
}

export async function readStandingHash(path: string = HASH_PATH): Promise<string> {
  return (await readFile(path, "utf8").catch(() => "")).trim()
}

/**
 * Every app in the registry, via the token-authenticated fleet endpoint.
 *
 * The registry is the only place that knows what has been delivered; a Vercel
 * project list would also include projects Werft never made.
 */
export async function fetchFleet(registryBase: string, token: string): Promise<FleetApp[]> {
  const response = await fetch(`${registryBase}/api/registry/apps`, {
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => null)
  if (!response?.ok) return []

  const body = (await response.json().catch(() => null)) as { apps?: FleetApp[] } | null
  return body?.apps ?? []
}

/**
 * Sets one environment variable on a Vercel project, for both targets.
 *
 * `upsert=true` because this is a rotation: the variable already exists on
 * every app that has ever been signed into, and a plain create would 409.
 * Preview as well as production, so a PR's preview deployment accepts the same
 * password rather than becoming unenterable.
 */
export async function setVercelEnv(
  projectName: string,
  key: string,
  value: string,
  token: string,
): Promise<boolean> {
  const response = await fetch(
    `https://api.vercel.com/v10/projects/${projectName}/env?upsert=true`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        key,
        value,
        type: "encrypted",
        target: ["production", "preview"],
      }),
    },
  ).catch(() => null)
  return response?.ok ?? false
}

/**
 * Rebuilds the app so the new value is actually in force.
 *
 * Vercel captures environment variables into a deployment, so a project whose
 * variable changed keeps serving the old one until something redeploys. Without
 * this the rotation would report success while every app still accepted only
 * the previous password — the worst kind of half-done, because it looks whole.
 *
 * --no-wait: a fleet rotation should not sit through each build in series.
 */
export async function redeployProduction(url: string): Promise<boolean> {
  const result = await exec("vercel", ["redeploy", url, "--no-wait", "--target", "production"])
  return result.code === 0
}

/**
 * Pushes the standing hash to every delivered app.
 *
 * Reports per app, and never claims more than it did: an app whose variable was
 * set but whose redeploy failed is "env-only", which is honest about the fact
 * that the new password is not live there yet.
 */
export async function refreshFleet(
  hash: string,
  apps: readonly FleetApp[],
  vercelToken: string,
  log: (line: string) => void,
): Promise<AppOutcome[]> {
  const outcomes: AppOutcome[] = []

  for (const app of apps) {
    if (app.url === "") {
      outcomes.push({ name: app.name, outcome: "skipped", detail: "never deployed" })
      log(`  ${app.name}: skipped (never deployed)`)
      continue
    }

    const envSet = await setVercelEnv(app.name, "WERFT_PASSWORD_HASH", hash, vercelToken)
    if (!envSet) {
      outcomes.push({
        name: app.name,
        outcome: "failed",
        detail: "Vercel refused the environment variable — is this app's project still there?",
      })
      log(`  ${app.name}: FAILED to set the variable`)
      continue
    }

    const redeployed = await redeployProduction(app.url)
    outcomes.push({
      name: app.name,
      outcome: redeployed ? "updated" : "env-only",
      detail: redeployed ? undefined : "variable set, but the redeploy did not start — rerun it",
    })
    log(
      `  ${app.name}: ${redeployed ? "updated and redeploying" : "variable set, REDEPLOY FAILED"}`,
    )
  }

  return outcomes
}

/**
 * Whether an app is one Werft actually built.
 *
 * This matters more than it looks. The registry also holds apps that predate
 * Werft and were backfilled into it by hand — they have no werft.json, no
 * single-operator gate, and no WERFT_PASSWORD_HASH to rotate. Rotating "every
 * app" without this filter would set a variable they ignore and then *redeploy
 * fifteen unrelated production apps*, which is a much worse outcome than the
 * problem being solved.
 *
 * werft.json is the discriminator because it is exactly what a scaffolded app
 * has and a backfilled row does not. Nothing new to maintain, and it stays
 * correct for apps created before or after this existed.
 */
export async function isWerftApp(
  name: string,
  runGh: (args: readonly string[]) => Promise<{ code: number }>,
): Promise<boolean> {
  const result = await runGh(["api", `repos/vinoth4v/${name}/contents/werft.json`, "--silent"])
  return result.code === 0
}
