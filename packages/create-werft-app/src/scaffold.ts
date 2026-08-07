import { randomBytes } from "node:crypto"
import { readFile, rm, stat, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import type { Options } from "./args.ts"
import { type ExecOptions, type ExecResult, exec, quote } from "./exec.ts"
import { Ledger, type Resource } from "./ledger.ts"
import {
  createNeonProject,
  deleteNeonProject,
  neonDeleteCommand,
  verifyNeonApiKey,
} from "./neon.ts"
import { NAME_PATTERN, renderWerftJson, type WerftJson } from "./werft-json.ts"

export type Logger = {
  step: (text: string) => void
  info: (text: string) => void
  warn: (text: string) => void
  error: (text: string) => void
}

export type ScaffoldSuccess = {
  ok: true
  dir: string
  url: string
  notes: string[]
}

export type ScaffoldFailure = {
  ok: false
  failedAt: string
  reason: string
  orphaned: Resource[]
  notes: string[]
}

export type ScaffoldOutcome = ScaffoldSuccess | ScaffoldFailure

class StepFailure extends Error {}

/**
 * Runs commands, and knows which ones a dry run must not perform.
 *
 * `local` always runs — a dry run still copies the template, installs, and
 * builds, because that is the part worth rehearsing. `remote` is skipped, since
 * it is the part that creates things somebody has to clean up.
 */
class Runner {
  // Plain fields rather than constructor parameter properties: Node runs this
  // file by stripping types, and parameter properties emit code.
  readonly dryRun: boolean
  private readonly log: Logger

  constructor(dryRun: boolean, log: Logger) {
    this.dryRun = dryRun
    this.log = log
  }

  async local(
    command: string,
    args: readonly string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    this.log.info(`$ ${quote(command, args)}`)
    const result = await exec(command, args, options)
    if (result.code !== 0) {
      throw new StepFailure(
        `${quote(command, args)} exited ${result.code}${result.stderr ? `\n${indent(result.stderr)}` : ""}`,
      )
    }
    return result
  }

  /** Runs and returns the result without throwing — for preflight checks. */
  async probe(
    command: string,
    args: readonly string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    return exec(command, args, options)
  }

  async remote(
    command: string,
    args: readonly string[],
    options?: ExecOptions,
  ): Promise<ExecResult> {
    if (this.dryRun) {
      this.log.info(`[dry-run] would run: ${quote(command, args)}`)
      return { code: 0, stdout: "", stderr: "" }
    }
    return this.local(command, args, options)
  }

  get isDryRun(): boolean {
    return this.dryRun
  }
}

export async function scaffold(options: Options, log: Logger): Promise<ScaffoldOutcome> {
  const runner = new Runner(options.dryRun, log)
  const ledger = new Ledger()
  const notes: string[] = []
  let currentStep = "preflight"
  let url = ""

  const name = options.name ?? ""
  const dir = resolve(options.dir ?? `./${name}`)
  const webDir = join(dir, "apps", "web")
  const neonApiKey = process.env.NEON_API_KEY ?? ""

  try {
    // ---- 1. preflight -----------------------------------------------------
    log.step("Preflight")
    if (!NAME_PATTERN.test(name)) {
      throw new StepFailure(
        `--name "${name}" must be lowercase letters, digits and hyphens, 2-40 characters`,
      )
    }
    if (await exists(dir)) {
      throw new StepFailure(`${dir} already exists — refusing to write into it`)
    }
    if ((await runner.probe("git", ["--version"])).code !== 0) {
      throw new StepFailure("git is not on PATH")
    }

    let owner = "<your-github-account>"
    const ghStatus = await runner.probe("gh", ["auth", "status"])
    if (ghStatus.code === 0) {
      const login = await runner.probe("gh", ["api", "user", "--jq", ".login"])
      if (login.code === 0 && login.stdout !== "") owner = login.stdout
    } else {
      requireForRealRun(
        runner,
        notes,
        "gh is not installed or not authenticated — run: gh auth login",
      )
    }

    if ((await runner.probe("vercel", ["whoami"])).code !== 0) {
      requireForRealRun(
        runner,
        notes,
        "vercel is not installed or not authenticated — run: vercel login",
      )
    }

    if (neonApiKey === "") {
      requireForRealRun(
        runner,
        notes,
        "NEON_API_KEY is not set — create a key at console.neon.tech",
      )
    } else {
      log.info("checking NEON_API_KEY")
      const check = await verifyNeonApiKey(neonApiKey)
      if (check === "rejected") {
        requireForRealRun(
          runner,
          notes,
          "Neon rejected NEON_API_KEY — check it is current, and not a placeholder exported verbatim",
        )
      } else if (check === "unreachable") {
        requireForRealRun(
          runner,
          notes,
          "could not reach the Neon API to verify NEON_API_KEY — check the network before provisioning",
        )
      }
    }

    if (!options.email && !options.dryRun) {
      notes.push("no --email given, so .env.local has a placeholder operator address")
    }

    // ---- 2. copy the template --------------------------------------------
    currentStep = "copy template"
    log.step(`Copying ${options.template}`)
    await runner.local("git", ["clone", "--depth", "1", options.template, dir])
    ledger.record({
      what: `local directory ${dir}`,
      cleanup: `rm -rf ${dir}`,
      undo: async () => {
        await rm(dir, { recursive: true, force: true })
        return true
      },
    })
    // The clone is a copy, not a fork: it keeps no history and no remote.
    await rm(join(dir, ".git"), { recursive: true, force: true })
    // Template-internal notes do not belong in an app built from it.
    await rm(join(dir, "docs"), { recursive: true, force: true })

    // ---- 3. configure it as its own app ----------------------------------
    currentStep = "configure app"
    log.step("Writing werft.json and app identity")
    const app: WerftJson = {
      name,
      description: options.description ?? `${name}, scaffolded from werft-template`,
      stack: options.stack ?? (await templateStack(dir)),
      url: "",
      tags: options.tags,
      status: options.status,
      private: options.private,
    }
    await writeFile(join(dir, "werft.json"), renderWerftJson(app), "utf8")
    await renameRootPackage(dir, name)
    await writeFile(join(dir, "README.md"), appReadme(app), "utf8")

    const authSecret = randomBytes(32).toString("base64")
    const envValues: Record<string, string> = {
      AUTH_SECRET: authSecret,
      WERFT_USER_EMAIL: options.email ?? "you@example.com",
    }

    // ---- 4. install ------------------------------------------------------
    currentStep = "install dependencies"
    if (options.skipInstall) {
      log.step("Skipping pnpm install")
      notes.push("--skip-install was passed, so the app has no node_modules yet")
    } else {
      log.step("Installing dependencies")
      await runner.local("pnpm", ["install"], { cwd: dir, stream: true })
    }

    // The template's own hashing code, rather than a second implementation
    // here that could drift from it. Piped, so it stays out of process listings.
    if (options.password && !options.skipInstall) {
      currentStep = "hash password"
      log.step("Hashing the operator password")
      const hashed = await runner.local("pnpm", ["hash-password"], {
        cwd: dir,
        input: options.password,
      })
      const hash = hashed.stdout.split("\n").at(-1)?.trim() ?? ""
      if (!hash.startsWith("scrypt$")) {
        throw new StepFailure("hash-password did not return a hash")
      }
      envValues.WERFT_PASSWORD_HASH = hash
    } else {
      notes.push("no password hashed — run `pnpm hash-password` and set WERFT_PASSWORD_HASH")
    }

    await upsertEnvLocal(webDir, envValues)

    // ---- 5. browsers -----------------------------------------------------
    currentStep = "install browsers"
    if (options.skipBrowsers || options.skipInstall) {
      log.step("Skipping playwright install chromium")
      notes.push("browsers not installed — run `pnpm exec playwright install chromium` in apps/web")
    } else {
      log.step("Installing the Playwright browser")
      await runner.local("pnpm", ["exec", "playwright", "install", "chromium"], {
        cwd: webDir,
        stream: true,
      })
    }

    // ---- 6. prove it builds before anything remote exists ----------------
    currentStep = "verify build"
    if (options.skipInstall) {
      log.step("Skipping build verification")
    } else {
      log.step("Verifying the app builds")
      await runner.local("pnpm", ["-r", "build"], { cwd: dir, stream: true })
    }

    // ---- 7. git ----------------------------------------------------------
    currentStep = "git init"
    log.step("Creating the first commit")
    await runner.local("git", ["init", "-q", "-b", "main"], { cwd: dir })
    await runner.local("git", ["add", "-A"], { cwd: dir })
    await runner.local("git", ["commit", "-q", "-m", `Scaffold ${name} from werft-template`], {
      cwd: dir,
    })

    // ---- 8. GitHub -------------------------------------------------------
    currentStep = "create GitHub repository"
    const slug = `${owner}/${name}`
    log.step(`Creating GitHub repository ${slug}`)
    await runner.remote("gh", [
      "repo",
      "create",
      name,
      options.private ? "--private" : "--public",
      "--source",
      dir,
      "--remote",
      "origin",
      "--push",
    ])
    if (!runner.isDryRun) {
      ledger.record({
        what: `GitHub repository ${slug}`,
        cleanup: `gh repo delete ${slug} --yes`,
        // Usually fails: the default gh token has no delete_repo scope. The
        // printed command still works once the scope is granted.
        undo: async () => (await exec("gh", ["repo", "delete", slug, "--yes"])).code === 0,
      })
    }

    // ---- 9. Neon ---------------------------------------------------------
    currentStep = "create Neon project"
    log.step("Creating the Neon project")
    if (runner.isDryRun) {
      log.info(`[dry-run] would POST https://console.neon.tech/api/v2/projects {"name":"${name}"}`)
    } else {
      const project = await createNeonProject(name, neonApiKey)
      ledger.record({
        what: `Neon project ${project.id}`,
        cleanup: neonDeleteCommand(project.id),
        undo: async () => deleteNeonProject(project.id, neonApiKey),
      })
      envValues.DATABASE_URL = project.connectionUri
      await upsertEnvLocal(webDir, envValues)

      currentStep = "run migrations"
      log.step("Running migrations against the new database")
      await runner.local("pnpm", ["db:migrate"], {
        cwd: dir,
        env: { DATABASE_URL: project.connectionUri },
        stream: true,
      })
    }

    // ---- 10. Vercel ------------------------------------------------------
    currentStep = "create and link Vercel project"
    log.step(`Linking the Vercel project ${name}`)
    await runner.remote("vercel", ["link", "--yes", "--project", name], { cwd: dir })
    if (!runner.isDryRun) {
      ledger.record({
        what: `Vercel project ${name}`,
        // `vercel project rm` has no --yes: it rejects the flag outright and
        // then prompts. The confirmation is piped in.
        cleanup: `printf 'y\\n' | vercel project rm ${name}`,
        undo: async () =>
          (await exec("vercel", ["project", "rm", name], { input: "y\n" })).code === 0,
      })
    }

    currentStep = "push environment variables"
    log.step("Pushing environment variables to Vercel production")
    for (const [key, value] of Object.entries(envValues)) {
      await runner.remote("vercel", ["env", "add", key, "production", "--force"], {
        cwd: dir,
        input: value,
      })
    }

    // ---- 11. optional deploy --------------------------------------------
    if (options.deploy) {
      currentStep = "deploy"
      log.step("Deploying to production")
      const deployed = await runner.remote("vercel", ["deploy", "--prod", "--yes"], { cwd: dir })
      url = /https:\/\/[^\s]+/.exec(deployed.stdout)?.[0] ?? ""
      if (url === "" && !runner.isDryRun) {
        notes.push("the deploy produced no URL — set werft.json url by hand")
      }
    } else {
      notes.push("not deployed — run `vercel deploy --prod` when ready, then set werft.json url")
    }

    // ---- 12. record the URL ---------------------------------------------
    if (url !== "" && !runner.isDryRun) {
      currentStep = "record the deployment URL"
      log.step("Recording the URL in werft.json")
      await writeFile(join(dir, "werft.json"), renderWerftJson({ ...app, url }), "utf8")
      await runner.local("git", ["add", "werft.json"], { cwd: dir })
      await runner.local("git", ["commit", "-q", "-m", "Record deployment URL"], { cwd: dir })
      await runner.local("git", ["push", "-q"], { cwd: dir })
    }

    return { ok: true, dir, url, notes }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    log.error(`Failed during ${currentStep}: ${reason}`)

    if (ledger.size === 0) {
      return { ok: false, failedAt: currentStep, reason, orphaned: [], notes }
    }

    if (!options.rollback) {
      log.warn("--no-rollback: leaving everything in place")
      return { ok: false, failedAt: currentStep, reason, orphaned: [...ledger.entries()], notes }
    }

    log.warn(`Rolling back ${ledger.size} created resource(s)`)
    const orphaned = await ledger.rollback((resource, undone) => {
      log.info(`${undone ? "removed" : "COULD NOT REMOVE"}: ${resource.what}`)
    })

    return { ok: false, failedAt: currentStep, reason, orphaned, notes }
  }
}

/** A missing credential is fatal for a real run and merely noted for a dry one. */
function requireForRealRun(runner: Runner, notes: string[], problem: string): void {
  if (runner.isDryRun) {
    notes.push(`dry run continued despite: ${problem}`)
    return
  }
  throw new StepFailure(problem)
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Reads the stack the template describes for itself, so it stays one source. */
async function templateStack(dir: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, "werft.json"), "utf8")) as {
      stack?: unknown
    }
    if (Array.isArray(parsed.stack) && parsed.stack.every((e) => typeof e === "string")) {
      return parsed.stack
    }
  } catch {
    // fall through
  }
  return ["next", "typescript", "neon", "drizzle", "next-auth", "vercel"]
}

async function renameRootPackage(dir: string, name: string): Promise<void> {
  const path = join(dir, "package.json")
  const parsed = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>
  parsed.name = name
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8")
}

/**
 * Merges values into .env.local, preserving anything already there.
 *
 * The file is gitignored, so secrets written here are never committed.
 */
async function upsertEnvLocal(webDir: string, values: Record<string, string>): Promise<void> {
  const path = join(webDir, ".env.local")
  const existing = await readFile(path, "utf8").catch(() => "")
  const entries = new Map<string, string>()

  for (const line of existing.split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    const key = match?.[1]
    if (key !== undefined) entries.set(key, match?.[2] ?? "")
  }
  for (const [key, value] of Object.entries(values)) {
    entries.set(key, JSON.stringify(value))
  }

  const body = [...entries].map(([key, value]) => `${key}=${value}`).join("\n")
  await writeFile(path, `${body}\n`, "utf8")
}

function appReadme(app: WerftJson): string {
  return `# ${app.name}

${app.description}

Scaffolded from werft-template. Conventions and hard rules live in AGENTS.md.

\`\`\`bash
pnpm install
pnpm dev
\`\`\`

Environment lives in \`apps/web/.env.local\`; \`apps/web/.env.example\` lists what
is needed. Run \`pnpm hash-password\` to set the operator password.
`
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")
}
