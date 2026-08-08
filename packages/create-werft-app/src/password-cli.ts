import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { exec } from "./exec.ts"
import {
  fetchFleet,
  HASH_PATH,
  isWerftApp,
  looksLikeHash,
  readStandingHash,
  refreshFleet,
  writeStandingHash,
} from "./operator-password.ts"
import { resolveVercelToken } from "./vercel.ts"

/**
 * `pnpm werft-password` — set the one operator password, everywhere.
 *
 * Replaces a five-command chain that had to be got exactly right (hash, write,
 * chmod, set the secret, then somehow reach every existing app) and silently
 * did nothing if any link failed. One command, and it says what it changed.
 *
 * The password is read from a hidden prompt or a pipe and never written down:
 * what is stored, set and pushed is the scrypt hash.
 */

const REGISTRY = process.env.WERFT_REGISTRY_URL ?? "https://werft-marketplace.vercel.app"

async function readSharedFile(name: string): Promise<string> {
  return (await readFile(join(homedir(), ".config", "werft", name), "utf8").catch(() => "")).trim()
}

function help(): string {
  return `usage: pnpm werft-password [options]

Sets the standing operator password: stores its hash, arms the scaffold's
secret so new apps get it, and pushes it to every app already delivered.

options:
  --no-fleet       only store the hash and set the secret; leave existing apps
  --fleet-only     only refresh existing apps, using the stored hash
  --help

The password is read from a hidden prompt, or from stdin when piped:
  echo 'my password' | pnpm werft-password
`
}

/** Reads a password without echoing it, so it stays off the screen. */
async function promptHidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // Piped: take the first line and do not prompt.
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks).toString("utf8").split("\n")[0]?.trim() ?? ""
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
  // Suppress the echo of what is typed, but keep the prompt itself visible.
  const asMutable = rl as unknown as { _writeToOutput?: (text: string) => void }
  let shown = false
  asMutable._writeToOutput = (text: string) => {
    if (!shown) {
      process.stdout.write(prompt)
      shown = true
    } else if (text.includes("\n")) {
      process.stdout.write("\n")
    }
  }

  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close()
      resolve(answer.trim())
    })
  })
}

async function main(): Promise<number> {
  const args = process.argv.slice(2)
  if (args.includes("--help") || args.includes("-h")) {
    console.log(help())
    return 0
  }

  const fleetOnly = args.includes("--fleet-only")
  const noFleet = args.includes("--no-fleet")

  let hash = ""

  if (fleetOnly) {
    hash = await readStandingHash()
    if (!looksLikeHash(hash)) {
      console.error(`no usable hash at ${HASH_PATH} — run without --fleet-only to set one`)
      return 1
    }
    console.log(`Using the stored hash from ${HASH_PATH}`)
  } else {
    const password = await promptHidden("New operator password: ")
    if (password === "") {
      console.error("no password given — nothing changed")
      return 1
    }
    if (password.length < 12) {
      // Refused rather than warned: this one password opens every app.
      console.error("too short — use at least 12 characters. Nothing changed.")
      return 1
    }

    // The template's own hashing code, so there is one implementation of it.
    const hashed = await exec("pnpm", ["hash-password"], { input: password })
    hash = hashed.stdout.split("\n").at(-1)?.trim() ?? ""
    if (!looksLikeHash(hash)) {
      console.error("hash-password did not return a hash — nothing changed")
      return 1
    }

    await writeStandingHash(hash)
    console.log(`Stored the hash in ${HASH_PATH}`)

    // So apps scaffolded on a runner get it too.
    const secret = await exec(
      "gh",
      ["secret", "set", "WERFT_PASSWORD_HASH", "--repo", "vinoth4v/werft-template"],
      { input: hash },
    )
    console.log(
      secret.code === 0
        ? "Armed WERFT_PASSWORD_HASH on werft-template, so new apps inherit it"
        : `Could not set the GitHub secret (${secret.stderr.split("\n")[0] ?? "unknown"}) — new apps scaffolded on a runner will have no password until you do`,
    )
  }

  if (noFleet) {
    console.log("\nExisting apps left alone (--no-fleet).")
    return 0
  }

  // Environment first, then the durable file — the same order every other
  // shared secret in this project resolves in.
  const token = process.env.WERFT_REGISTRY_TOKEN || (await readSharedFile("registry-token"))
  if (!token) {
    console.error(
      "\nno WERFT_REGISTRY_TOKEN — cannot list the fleet, so existing apps are unchanged",
    )
    return 1
  }

  const apps = await fetchFleet(REGISTRY, token)
  if (apps.length === 0) {
    console.error("\nthe registry returned no apps — is the token current?")
    return 1
  }

  // Only apps Werft built. The registry also lists apps backfilled by hand,
  // which have no operator gate to rotate — and redeploying those would touch
  // production apps that have nothing to do with this.
  console.log(`\nChecking which of ${apps.length} registry apps Werft actually built…`)
  const delivered: typeof apps = []
  for (const app of apps) {
    if (app.name === "werft-template") continue
    if (await isWerftApp(app.name, (args) => exec("gh", args))) delivered.push(app)
  }

  if (delivered.length === 0) {
    console.error("no Werft-built apps found — existing apps unchanged")
    return 1
  }
  console.log(`${delivered.length} of them: ${delivered.map((a) => a.name).join(", ")}`)

  const auth = await resolveVercelToken()
  if (!auth) {
    console.error("\nno Vercel API token — run `vercel login` or set VERCEL_TOKEN")
    return 1
  }

  console.log(`\nRefreshing ${delivered.length} app${delivered.length === 1 ? "" : "s"}:`)
  const outcomes = await refreshFleet(hash, delivered, auth.token, (line) => console.log(line))

  const failed = outcomes.filter((o) => o.outcome === "failed" || o.outcome === "env-only")
  console.log(
    `\n${outcomes.filter((o) => o.outcome === "updated").length} updated, ` +
      `${outcomes.filter((o) => o.outcome === "skipped").length} skipped, ${failed.length} needing attention`,
  )
  for (const outcome of failed) {
    console.log(`  ${outcome.name}: ${outcome.detail ?? outcome.outcome}`)
  }
  console.log("\nRedeploys were started, not waited for — give them a minute before signing in.")

  return failed.length === 0 ? 0 : 1
}

process.exitCode = await main()
