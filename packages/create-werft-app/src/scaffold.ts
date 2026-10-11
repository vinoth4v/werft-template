import { randomBytes } from "node:crypto"
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import {
  appsDbDeleteCommand,
  createAppDatabase,
  deleteAppDatabase,
  verifyAppsDb,
} from "./appsdb.ts"
import type { Options } from "./args.ts"
import {
  appDomain,
  coolifyDeleteCommand,
  coolifyFromEnv,
  createCoolifyApp,
  deleteCoolifyApp,
  deployCoolifyApp,
  setCoolifyEnv,
  verifyCoolify,
  waitForDeployment,
} from "./coolify.ts"
import { type ExecOptions, type ExecResult, exec, quote } from "./exec.ts"
import { createAppAwsUser, deleteAppAwsUser } from "./iam.ts"
import { Ledger, type Resource } from "./ledger.ts"
import { REGIONS } from "./regions.ts"
import { createBucket, deleteBucket, resolveAwsCredentials } from "./s3.ts"
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
  // Default home is ~/Documents/workspace/<name> — where the operator keeps
  // every other app — not the current directory, which on a CI runner is a
  // checkout of the template itself.
  const dir = resolve(options.dir ?? join(homedir(), "Documents", "workspace", name))
  const webDir = join(dir, "apps", "web")
  const appsDbAdminUrl = process.env.APPS_DB_ADMIN_URL ?? ""
  const coolify = coolifyFromEnv()
  const region = options.region ? REGIONS[options.region] : undefined

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

    // The deployment and the database live on the home server; both are only
    // reachable from inside the home network, which is why a real run happens
    // on the self-hosted runner (scaffold-app.yml), not on a laptop.
    if (!coolify) {
      requireForRealRun(
        runner,
        notes,
        "COOLIFY_API_URL / COOLIFY_API_TOKEN are not set — real runs happen on the home runner (scaffold-app.yml)",
      )
    } else {
      log.info("checking the Coolify API")
      const check = await verifyCoolify(coolify)
      if (check !== "ok") {
        requireForRealRun(
          runner,
          notes,
          `Coolify ${check === "rejected" ? "rejected COOLIFY_API_TOKEN" : "is unreachable at COOLIFY_API_URL"}`,
        )
      }
    }

    if (appsDbAdminUrl === "") {
      requireForRealRun(
        runner,
        notes,
        "APPS_DB_ADMIN_URL is not set — real runs happen on the home runner (scaffold-app.yml)",
      )
    } else {
      log.info("checking apps-db")
      const check = await verifyAppsDb(appsDbAdminUrl)
      if (check !== "ok") {
        requireForRealRun(
          runner,
          notes,
          `apps-db ${check === "rejected" ? "rejected APPS_DB_ADMIN_URL" : "is unreachable"}`,
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
      // Omitted rather than defaulted to the slug: the registry falls back to
      // the name on its own, and writing name twice into every werft.json
      // would make the field look required when it is not.
      ...(options.title ? { title: options.title } : {}),
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
    // Somewhere for an app to keep its own reasoning. werft's docs/ was just
    // removed as template-internal; these replace it with the app's own, seeded
    // rather than left to be invented differently by every app.
    await mkdir(join(dir, "docs"), { recursive: true })
    await writeFile(join(dir, "docs", "ARCHITECTURE.md"), appArchitectureDoc(app), "utf8")
    await writeFile(join(dir, "docs", "SESSIONS.md"), appSessionLog(app), "utf8")

    // The chosen theme, committed with the app. The token package's build
    // script reads this; absent (or "werft") means the default look. Writing
    // it always keeps the app self-describing rather than special-casing the
    // default away.
    await writeFile(
      join(dir, "packages", "tokens", "theme.json"),
      `${JSON.stringify({ theme: options.theme }, null, 2)}\n`,
      "utf8",
    )
    if (options.theme !== "werft") log.info(`theme: ${options.theme}`)

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
      // No --password given: reuse the operator's standing hash, the same way
      // KOMPASS_TOKEN and WERFT_REGISTRY_TOKEN are reused. Without this every
      // app created from the marketplace form shipped with no password at all
      // and could not be signed into — the form deliberately has no password
      // field, because workflow_dispatch inputs are visible in the run log of
      // a public repo, and refusing the input without offering another path
      // left the app locked.
      //
      // It is the hash that travels, never a password: the same value the app
      // stores in its own environment. One hash across the fleet is the
      // operator's explicit choice — one standing credential for every app —
      // and the tradeoff is that it is only as isolated as the weakest app's
      // environment. Per-app passwords remain available via --password.
      const sharedHash = await resolveSharedSecret("WERFT_PASSWORD_HASH", "password-hash")
      if (sharedHash.startsWith("scrypt$")) {
        envValues.WERFT_PASSWORD_HASH = sharedHash
        notes.push("sign-in uses your standing operator password (shared hash)")
      } else if (sharedHash === "") {
        notes.push(
          "no password set — this app cannot be signed into yet. Store your hash once with: pnpm hash-password '<password>' > ~/.config/werft/password-hash && gh secret set WERFT_PASSWORD_HASH --repo vinoth4v/werft-template < ~/.config/werft/password-hash",
        )
      } else {
        notes.push(
          "WERFT_PASSWORD_HASH was found but is not a scrypt hash — ignored, so this app has no password. Regenerate it with `pnpm hash-password`",
        )
      }
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

    // ---- 9. database -----------------------------------------------------
    currentStep = "create the database"
    log.step("Creating the database on apps-db")
    // Captured for the Coolify step, which sets the preview database too.
    let previewDatabaseUrl = ""

    if (runner.isDryRun) {
      log.info(
        `[dry-run] would create role, database and ${name.replace(/-/g, "_")}_preview on apps-db`,
      )
    } else {
      const database = await createAppDatabase(name, appsDbAdminUrl)
      ledger.record({
        what: `apps-db database ${database.database} (and ${database.database}_preview, role ${database.role})`,
        cleanup: appsDbDeleteCommand(name),
        undo: async () => (await deleteAppDatabase(name, appsDbAdminUrl)) !== "failed",
      })
      envValues.DATABASE_URL = database.connectionUri
      previewDatabaseUrl = database.previewUri
      await upsertEnvLocal(webDir, envValues)

      currentStep = "run migrations"
      log.step("Running migrations against the new database")
      await runner.local("pnpm", ["db:migrate"], {
        cwd: dir,
        env: { DATABASE_URL: database.connectionUri },
        stream: true,
      })
    }

    // ---- 9b. optional S3 bucket ------------------------------------------
    // For apps whose architecture needs blob storage — the fleet already had
    // six such buckets before the scaffold could make them. Opt-in: most apps
    // never touch S3, and an unused empty bucket is clutter, not a safety net.
    currentStep = "create S3 bucket"
    if (options.withS3) {
      // Bucket names are globally unique across all of AWS and DNS-constrained,
      // so the app name alone is a coin-flip to be taken; a short random
      // suffix makes collision effectively impossible while staying legible.
      const bucket = `${name}-werft-${randomBytes(3).toString("hex")}`
      const awsRegion = region?.aws ?? "eu-central-1"
      if (runner.isDryRun) {
        log.step("Creating the S3 bucket")
        log.info(`[dry-run] would create bucket ${bucket} in ${awsRegion}`)
      } else {
        log.step(`Creating the S3 bucket ${bucket}`)
        const creds = await resolveAwsCredentials()
        if (!creds) {
          throw new StepFailure(
            "no AWS credentials: set AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY or a [default] profile in ~/.aws/credentials. --with-s3 needs them",
          )
        }
        await createBucket(bucket, awsRegion, creds)
        ledger.record({
          what: `S3 bucket ${bucket}`,
          cleanup: `aws s3api delete-bucket --bucket ${bucket} --region ${awsRegion}`,
          undo: async () => deleteBucket(bucket, awsRegion, creds),
        })

        // A per-app IAM user scoped to exactly this bucket — so the app holds
        // its own least-privilege key, never the admin key that made it. This
        // is the whole point of "configured from Werft, never the console".
        currentStep = "create scoped AWS user"
        log.step("Minting a bucket-scoped AWS user for the app")
        const awsUser = await createAppAwsUser(name, bucket, creds)
        ledger.record({
          what: `IAM user ${awsUser.userName}`,
          cleanup: `aws iam delete-user --user-name ${awsUser.userName} (delete its access key and inline policy first)`,
          undo: async () => deleteAppAwsUser(awsUser.userName, awsUser.accessKeyId, creds),
        })

        // The app reads these four. The bucket is empty and private; the key
        // can touch this bucket and nothing else in the account.
        envValues.S3_BUCKET = bucket
        envValues.AWS_REGION = awsRegion
        envValues.AWS_ACCESS_KEY_ID = awsUser.accessKeyId
        envValues.AWS_SECRET_ACCESS_KEY = awsUser.secretAccessKey
        await upsertEnvLocal(webDir, envValues)
        log.info(
          `bucket ${bucket} + scoped IAM user ${awsUser.userName} — admin key never leaves the runner`,
        )
        notes.push(
          `S3 ready: bucket ${bucket}, plus a bucket-scoped AWS user (${awsUser.userName}) whose key the app holds — the admin key was never copied into the app`,
        )
      }
    }

    // ---- 10. Coolify -----------------------------------------------------
    // Builds the Dockerfile on every push to main and gives every PR a preview
    // at pr<N>-<name>.<domain>. Routing needs nothing per app: the wildcard DNS
    // record and tunnel rule send unknown hosts to Coolify's proxy already.
    currentStep = "create the Coolify application"
    const domain = appDomain(name)
    let coolifyUuid = ""
    log.step(`Creating the Coolify application ${name} (https://${domain})`)
    if (runner.isDryRun) {
      log.info(
        `[dry-run] would create a Coolify application from ${slug}, domain ${domain}, previews on`,
      )
    } else if (coolify) {
      coolifyUuid = await createCoolifyApp(coolify, { name, repository: slug, domain })
      ledger.record({
        what: `Coolify application ${name}`,
        cleanup: coolifyDeleteCommand(name),
        undo: async () => (await deleteCoolifyApp(coolify, name)) === "removed",
      })
    }
    envValues.AUTH_URL = `https://${domain}`
    envValues.AUTH_TRUST_HOST = "true"

    // What the app itself needs to reach a model at runtime. Distinct from the
    // KOMPASS_TOKEN armed as a repository secret: that one is for CI, this one
    // is read by the running app through src/kompass.ts. Set unconditionally,
    // because whether a feature needs AI is decided long after scaffolding, and
    // an app that never calls a model never reads them.
    const kompassToken = await resolveSharedSecret("KOMPASS_TOKEN", "kompass-token")
    if (kompassToken) {
      envValues.KOMPASS_BASE_URL =
        process.env.KOMPASS_BASE_URL ?? "https://kompass.vinoth4v.workers.dev"
      envValues.KOMPASS_TOKEN = kompassToken
    } else {
      notes.push(
        "no KOMPASS_TOKEN found, so the app cannot call a model at runtime — set it later in Coolify (the app's Environment Variables) if a feature needs one",
      )
    }

    currentStep = "set environment variables"
    log.step("Setting environment variables in Coolify")
    // Production gets every value. Previews get the same (Coolify copies them),
    // except the database: previews run on <db>_preview, and IS_PREVIEW lets
    // deploy/start.mjs refuse a preview that is somehow pointed at production.
    // Sign-in on a preview follows the preview's own host (deploy/start.mjs).
    const previewOverrides: Record<string, string> = { IS_PREVIEW: "true" }
    if (previewDatabaseUrl) previewOverrides.DATABASE_URL = previewDatabaseUrl
    for (const [key, value] of Object.entries(envValues)) {
      if (runner.isDryRun || !coolify) {
        log.info(`[dry-run] would set ${key} in Coolify`)
        continue
      }
      await setCoolifyEnv(coolify, coolifyUuid, key, value)
    }
    for (const [key, value] of Object.entries(previewOverrides)) {
      if (runner.isDryRun || !coolify) {
        log.info(`[dry-run] would set ${key} for previews`)
        continue
      }
      await setCoolifyEnv(coolify, coolifyUuid, key, value, { preview: true })
    }

    // ---- 11. arm the CI pipeline ------------------------------------------
    // The workflows this app inherited (pr-checks, pr-cleanup, reap, registry
    // upsert, claude) are dead without their secrets. Every value is in hand
    // right now — setting them here is what makes "one command gives you a
    // deployed app" include a pipeline that actually runs, instead of a repo
    // whose CI fails on its first PR until someone wires it by hand.
    //
    // Before the record-URL push, not after: that push triggers
    // registry-upsert.yml, and a real run proved the race — the workflow
    // started at 14:32:34 while WERFT_REGISTRY_TOKEN landed at 14:32:36, so
    // it skipped "gracefully" and the app silently never self-registered.
    currentStep = "set repository CI secrets"
    log.step("Setting the repository's CI secrets")
    // Nothing per project any more: the PR pipeline needs no deployment
    // credentials (Coolify builds previews itself; preview-smoke only reads the
    // preview's public /werft-commit.txt). Only the shared secrets below.
    const ciSecrets: Record<string, string> = {}

    // Shared across every app, unlike the per-project values above. Sourced
    // from the environment or ~/.config/werft/, never invented.
    for (const [secretName, fileName] of [
      ["WERFT_REGISTRY_TOKEN", "registry-token"],
      // @claude runs on the operator's Claude subscription; KOMPASS_TOKEN is
      // still armed because claude-escalate.yml falls back to the gateway.
      ["CLAUDE_CODE_OAUTH_TOKEN", "claude-oauth-token"],
      ["KOMPASS_TOKEN", "kompass-token"],
    ] as const) {
      const value = await resolveSharedSecret(secretName, fileName)
      if (value) ciSecrets[secretName] = value
      else {
        notes.push(
          `${secretName} not found in the environment or ~/.config/werft/${fileName} — set it with: gh secret set ${secretName} --repo ${slug}`,
        )
      }
    }

    for (const [secretName, value] of Object.entries(ciSecrets)) {
      if (runner.isDryRun) {
        log.info(`[dry-run] would run: gh secret set ${secretName} --repo ${slug} (value on stdin)`)
        continue
      }
      if (value === "") {
        notes.push(`${secretName} had no value to set — the CI pipeline needs it`)
        continue
      }
      // Value on stdin, never argv: argv is visible in process listings.
      await runner.remote("gh", ["secret", "set", secretName, "--repo", slug], { input: value })
    }

    // ---- 12. optional deploy --------------------------------------------
    if (options.deploy) {
      currentStep = "deploy"
      log.step("Deploying to production")
      if (runner.isDryRun || !coolify) {
        log.info(`[dry-run] would deploy ${name} on Coolify and wait for it`)
      } else {
        // The container migrates its own database and starts; a deploy that
        // never becomes healthy is rolled back by Coolify and reported here.
        const status = await waitForDeployment(
          coolify,
          await deployCoolifyApp(coolify, coolifyUuid),
        )
        if (status !== "finished") {
          throw new StepFailure(
            `the first deployment ${status} — see the deployment log in Coolify`,
          )
        }
        url = `https://${domain}`
        log.info(`deployed: ${url}`)
      }
    } else {
      notes.push(
        `not deployed — the first push to main deploys it, or press Deploy in Coolify; it will live at https://${domain}`,
      )
    }

    // ---- 13. record the URL ---------------------------------------------
    // With the secrets already set above, the push this makes triggers a
    // registry-upsert.yml run that actually has its token — the app registers
    // itself with its real URL on its own first merge, no manual step.
    if (url !== "" && !runner.isDryRun) {
      currentStep = "record the deployment URL"
      log.step("Recording the URL in werft.json")
      await writeFile(join(dir, "werft.json"), renderWerftJson({ ...app, url }), "utf8")
      await runner.local("git", ["add", "werft.json"], { cwd: dir })
      await runner.local("git", ["commit", "-q", "-m", "Record deployment URL"], { cwd: dir })
      await runner.local("git", ["push", "-q"], { cwd: dir })
    }

    // ---- 14. protect main, last -------------------------------------------
    // Last on purpose: required status checks reject direct pushes to main
    // (GH006) even from the repo owner, and step 13 pushes to main. Public
    // repos only — GitHub Free rejects this API on private repos outright.
    currentStep = "protect main"
    if (options.private) {
      notes.push(
        "branch protection not set: GitHub Free does not support required checks on a private repo — upgrade to Pro or make it public, then require gitleaks, typecheck, build, preview-smoke",
      )
    } else {
      log.step("Requiring the four checks on main")
      const protection = JSON.stringify({
        required_status_checks: {
          strict: false,
          // build as well as preview-smoke: preview-smoke needs build, and
          // GitHub does not treat a skipped required check as blocking.
          contexts: ["gitleaks", "typecheck", "build", "preview-smoke"],
        },
        enforce_admins: true,
        required_pull_request_reviews: null,
        restrictions: null,
      })
      await runner.remote(
        "gh",
        ["api", `repos/${slug}/branches/main/protection`, "-X", "PUT", "--input", "-"],
        { input: protection },
      )
      if (!runner.isDryRun) {
        notes.push("main is protected: every change from here on goes through a PR")
      }
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

/**
 * A secret shared across every Werft app, as opposed to the per-project ones
 * the scaffold creates itself: environment variable first, then a file the
 * operator keeps under ~/.config/werft/. Absent is fine — the caller notes it
 * rather than failing, since a pipeline missing one secret degrades to
 * exactly the manual step it always was.
 */
async function resolveSharedSecret(envName: string, fileName: string): Promise<string> {
  const fromEnv = process.env[envName]
  if (fromEnv) return fromEnv

  return (
    await readFile(join(homedir(), ".config", "werft", fileName), "utf8").catch(() => "")
  ).trim()
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
  return ["next", "typescript", "postgres", "drizzle", "next-auth", "coolify"]
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

/**
 * The README is the front door, and it is the one document that gets read by
 * someone who knows nothing.
 *
 * It has a different job from the other two, which is why all three exist.
 * ARCHITECTURE.md explains how the app works to someone about to change it.
 * SESSIONS.md records why past changes were made. The README answers the
 * question those two never do: *what is this, does it work, and what can I do
 * with it right now?*
 *
 * Seeded with its sections already in place, because an empty heading gets
 * filled and an absent one does not — the first version of this README was six
 * lines of install instructions, and every session left it that way while
 * writing eleven kilobytes of architecture nobody lands on first.
 */
function appReadme(app: WerftJson): string {
  const title = app.title ?? app.name
  return `# ${title}

${app.description}

> Scaffolded from [werft-template](https://github.com/vinoth4v/werft-template).
> The hard rules live in \`AGENTS.md\`, the design in \`docs/ARCHITECTURE.md\`,
> and why each change was made in \`docs/SESSIONS.md\`.

## What it does

_Replace this with what someone can actually do with the app today, in the
words they would use. Not a feature list of intentions — the things that work._

## What works, and what does not

_Two short lists, kept honest. The second one is the more useful: it stops a
reader assuming a gap is a bug, and stops the next session rebuilding something
that was deliberately left out. Deeper reasoning belongs in
\`docs/ARCHITECTURE.md\` under Known gaps; this is the summary._

## Run it

\`\`\`bash
pnpm install
pnpm dev
\`\`\`

Environment lives in \`apps/web/.env.local\`; \`apps/web/.env.example\` lists what
is needed. \`pnpm hash-password\` sets the operator password — an app with none
cannot be signed into.

## Change it

Say what you want in the app's page on the
[marketplace](https://werft-marketplace.vinothkannan.de), or comment \`@claude\` on an
issue here. Either way Claude works on a branch and opens a pull request; the
gates run against a real preview on a copy of the production database, and a
human merges. Nothing reaches production on its own.

## Deployment

Merging to \`main\` deploys (Coolify, on the home server). The new container
migrates the database before it starts serving — a failed migration stops it
and the previous deployment keeps serving.
`
}

/**
 * The app's current design, rewritten as it changes.
 *
 * Separate from SESSIONS.md on purpose, and the split is the whole point: a
 * document that records history cannot also describe the present without
 * becoming unreadable, and one that is rewritten each time loses why anything
 * was done. This is the present tense; SESSIONS.md is the past.
 *
 * The headings are fixed so an agent can find the data model without reading
 * the prose, and so two sessions do not invent two structures.
 */
function appArchitectureDoc(app: WerftJson): string {
  return `# ${app.name} — architecture

How this app works, in its current form. Rewritten whenever the design
changes, so it describes the present rather than accumulating history —
that is SESSIONS.md's job.

## Purpose

${app.description}

## Domain model

_The things this app talks about, and how they relate. Not tables — concepts._

## Data model

_Tables, their columns, and why they are shaped that way. Name the migration
that introduced each one, so a schema question can be traced to its change._

## Surfaces

_Routes, server actions and API endpoints, with what each one is for and who
may reach it. Everything is behind the operator gate unless stated here._

## External services

_Databases, buckets, model lanes, third-party APIs — and which environment
variable configures each. Anything that costs money or can fail belongs here._

## Decisions in force

_Choices that constrain future work, and the reason each one was made. A
decision without its reason gets reversed by the next session that finds it
inconvenient._

## Known gaps

_What is deliberately missing or unfinished, so it is not mistaken for an
oversight and quietly "fixed" in the wrong direction._
`
}

/**
 * Append-only record of build sessions.
 *
 * Exists because the reasoning behind a change is the part that disappears
 * first: the diff survives in git, the argument does not. An agent picking this
 * app up months later can read the diff; it cannot read what was considered and
 * rejected unless someone wrote it down.
 */
function appSessionLog(app: WerftJson): string {
  return `# ${app.name} — session log

One entry per build session, newest last. Append; never edit an existing
entry, for the same reason migrations are append-only — a corrected record of
what was decided is no longer a record.

Each entry answers: what was asked, what changed, what was decided and why,
what was rejected, and what is still open.

---

## Scaffolded

**Asked:** create the app.

**Changed:** scaffolded from werft-template — App Router, single-operator
auth, Postgres via Drizzle, design tokens, the PR gates, and \`@claude\` wired to
the operator's Claude subscription.

**Decided:** nothing yet beyond the template's own choices, which are in
AGENTS.md.

**Open:** everything the app is actually for. See ARCHITECTURE.md, which is
still a set of empty headings until the first feature lands.
`
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")
}
