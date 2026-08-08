import { randomBytes } from "node:crypto"
import { readFile, rm, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { Options } from "./args.ts"
import { type ExecOptions, type ExecResult, exec, quote } from "./exec.ts"
import { createAppAwsUser, deleteAppAwsUser } from "./iam.ts"
import { Ledger, type Resource } from "./ledger.ts"
import {
  createNeonProject,
  deleteNeonProject,
  neonDeleteCommand,
  verifyNeonApiKey,
} from "./neon.ts"
import { REGIONS } from "./regions.ts"
import { createBucket, deleteBucket, resolveAwsCredentials } from "./s3.ts"
import {
  extractDeployUrl,
  getProjectSettings,
  productionAliasUrl,
  readLinkedProject,
  resolveVercelToken,
  SSO_ENABLED,
  stableAliasUrl,
  updateProjectSettings,
} from "./vercel.ts"
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

  /**
   * Like `remote`, but a nonzero exit is not automatically a failure — the
   * caller decides, from the actual output, whether this run of the command
   * was redundant rather than wrong.
   *
   * `vercel git connect --yes` exits 1 when the repository is already
   * connected — which happens whenever `vercel link` auto-detected it — and
   * that is success, not a step to roll everything back over.
   */
  async remoteTolerant(
    command: string,
    args: readonly string[],
    alreadyDone: (result: ExecResult) => boolean,
    options?: ExecOptions,
  ): Promise<ExecResult> {
    if (this.dryRun) {
      this.log.info(`[dry-run] would run: ${quote(command, args)}`)
      return { code: 0, stdout: "", stderr: "" }
    }

    this.log.info(`$ ${quote(command, args)}`)
    const result = await exec(command, args, options)
    if (result.code === 0) return result
    if (alreadyDone(result)) {
      this.log.info("already done — treating as success")
      return result
    }
    throw new StepFailure(
      `${quote(command, args)} exited ${result.code}${result.stderr ? `\n${indent(result.stderr)}` : ""}`,
    )
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
  const neonApiKey = process.env.NEON_API_KEY ?? ""
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

    // ---- 9. Neon ---------------------------------------------------------
    currentStep = "create Neon project"
    log.step("Creating the Neon project")
    // Captured for the CI-secrets step at the end, which needs them after
    // these blocks' own scopes have closed.
    let neonProjectId = ""
    let vercelProjectId = ""
    let vercelOrgId = ""
    let vercelApiToken = ""
    let vercelTokenSource = ""

    if (runner.isDryRun) {
      log.info(`[dry-run] would POST https://console.neon.tech/api/v2/projects {"name":"${name}"}`)
    } else {
      const project = await createNeonProject(name, neonApiKey, region?.neon)
      neonProjectId = project.id
      ledger.record({
        what: `Neon project ${project.id}`,
        cleanup: neonDeleteCommand(project.id),
        undo: async () => deleteNeonProject(project.id, neonApiKey),
      })
      if (region) log.info(`Neon region: ${region.neon}`)
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

    // Connects the GitHub repo just pushed to this Vercel project, so pushes to
    // main deploy automatically and PR branches get preview deployments — the
    // whole premise of Phase 2. Also a prerequisite the API enforces: a
    // branch-scoped preview env var is refused on a project with no connected
    // Git repository, discovered by testing that call against a bare project.
    currentStep = "connect Vercel to the GitHub repository"
    log.step("Connecting Vercel to the GitHub repository")
    await runner.remoteTolerant(
      "vercel",
      ["git", "connect", "--yes"],
      (result) =>
        result.stdout.includes("already connected") || result.stderr.includes("already connected"),
      { cwd: dir },
    )

    // Before the first deploy, not after: Vercel otherwise builds this monorepo
    // from the repository root and looks for output there, so the build passes
    // and the deploy fails.
    currentStep = "configure the Vercel project"
    if (runner.isDryRun) {
      log.step("Configuring the Vercel project")
      log.info(
        `[dry-run] would PATCH /v9/projects/{id} {"rootDirectory":"apps/web","framework":"nextjs","ssoProtection":${options.vercelSso ? JSON.stringify(SSO_ENABLED) : "null"}}`,
      )
    } else {
      log.step("Configuring the Vercel project")
      const linked = await readLinkedProject(dir)
      if (!linked) {
        throw new StepFailure("vercel link wrote no .vercel/project.json to read the project from")
      }

      const auth = await resolveVercelToken()
      if (!auth) {
        throw new StepFailure(
          "no Vercel API token: run `vercel login`, or set VERCEL_TOKEN. `vercel link` sets neither of these settings on its own",
        )
      }
      log.info(`using the token from ${auth.source}`)
      vercelProjectId = linked.projectId
      vercelOrgId = linked.orgId
      vercelApiToken = auth.token
      vercelTokenSource = auth.source

      // Vercel applies SSO to every new project as a team-level default, so
      // clearing it is an explicit act on each one.
      await updateProjectSettings(linked, auth.token, {
        rootDirectory: "apps/web",
        framework: "nextjs",
        ssoProtection: options.vercelSso ? SSO_ENABLED : null,
        // Only when a region was chosen — omitting leaves Vercel's default,
        // so unregioned apps behave exactly as before.
        ...(region ? { serverlessFunctionRegion: region.vercel } : {}),
      })

      const confirmed = await getProjectSettings(linked, auth.token)
      const ssoMatches = Boolean(confirmed?.ssoProtection) === options.vercelSso
      const regionMatches = !region || confirmed?.serverlessFunctionRegion === region.vercel
      if (
        confirmed?.rootDirectory !== "apps/web" ||
        confirmed.framework !== "nextjs" ||
        !ssoMatches ||
        !regionMatches
      ) {
        throw new StepFailure(
          `Vercel reports rootDirectory=${confirmed?.rootDirectory ?? "unset"} framework=${confirmed?.framework ?? "unset"} sso=${confirmed?.ssoProtection ? "on" : "off"} region=${confirmed?.serverlessFunctionRegion ?? "default"} after asking for apps/web, nextjs, sso ${options.vercelSso ? "on" : "off"}${region ? `, region ${region.vercel}` : ""}`,
        )
      }
      log.info(
        `confirmed: rootDirectory = apps/web, framework = nextjs, Vercel SSO ${options.vercelSso ? "on" : "off"}${region ? `, region ${region.vercel}` : ""}`,
      )
      if (!options.vercelSso) {
        notes.push("Vercel SSO is off — the app's own single-user gate is the access control")
      }
    }

    // Both targets: production for the deployed app, preview so every PR
    // branch's deployment can authenticate and reach a database too, not just
    // the default DATABASE_URL a Neon-branch workflow overrides per PR later.
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
        "no KOMPASS_TOKEN found, so the app cannot call a model at runtime — set it later with `vercel env add KOMPASS_TOKEN` if a feature needs one",
      )
    }

    currentStep = "push environment variables"
    log.step("Pushing environment variables to Vercel")
    for (const target of ["production", "preview"]) {
      for (const [key, value] of Object.entries(envValues)) {
        await runner.remote("vercel", ["env", "add", key, target, "--force"], {
          cwd: dir,
          input: value,
        })
      }
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
    const ciSecrets: Record<string, string> = {
      NEON_API_KEY: neonApiKey,
      NEON_PROJECT_ID: neonProjectId,
      VERCEL_TOKEN: vercelApiToken,
      VERCEL_PROJECT_ID: vercelProjectId,
    }
    // Personal-account projects must not send a teamId at all — same rule the
    // Vercel API calls already follow.
    if (vercelOrgId.startsWith("team_")) ciSecrets.VERCEL_ORG_ID = vercelOrgId

    // The CLI's credential rotates roughly daily — a secret copied from it
    // went invalid the same afternoon once, taking every Vercel-touching CI
    // job with it. Arm it anyway (better than a dead pipeline today), but say
    // so loudly.
    if (vercelTokenSource === "vercel CLI") {
      notes.push(
        "VERCEL_TOKEN was armed from the CLI's rotating credential and will expire within ~a day — mint a long-lived token at vercel.com/account/tokens and keep it in ~/.config/werft/vercel-token",
      )
    }

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
      const deployed = await runner.remote("vercel", ["deploy", "--prod", "--yes"], { cwd: dir })
      // The stable alias, not the URL of this one deployment — Vercel
      // deployments are immutable, so recording a specific one goes stale the
      // moment the next deploy happens. extractDeployUrl still runs, only to
      // confirm the deploy actually printed something rather than silently
      // producing nothing.
      const thisDeployment = extractDeployUrl(deployed.stdout)
      if (thisDeployment === "" && !runner.isDryRun) {
        notes.push("the deploy produced no URL — something may be wrong; check `vercel ls`")
      }
      if (runner.isDryRun) {
        url = ""
      } else {
        // Ask Vercel rather than assuming `<name>.vercel.app`: a name that
        // collides with someone else's project gets a suffix, and guessing
        // records a URL that 404s. Fall back to the guess only if the API
        // cannot answer — every remote resource already exists by now, so
        // this must not be the thing that fails the run.
        url = vercelApiToken ? await productionAliasUrl(name, vercelApiToken, vercelOrgId) : ""
        if (url === "") {
          url = stableAliasUrl(name)
          notes.push(
            `could not read the production alias from Vercel — recorded ${url}, which is a guess; confirm with \`vercel inspect\` and fix werft.json if it differs`,
          )
        } else {
          log.info(`production alias: ${url}`)
        }
      }
    } else {
      notes.push("not deployed — run `vercel deploy --prod` when ready, then set werft.json url")
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
        "branch protection not set: GitHub Free does not support required checks on a private repo — upgrade to Pro or make it public, then require gitleaks, typecheck, build, neon-preview-branch, preview-smoke",
      )
    } else {
      log.step("Requiring the five checks on main")
      const protection = JSON.stringify({
        required_status_checks: {
          strict: false,
          // All five, and neon-preview-branch explicitly: preview-smoke only
          // skips (not fails) when its dependency fails, and GitHub does not
          // treat a skipped required check as blocking.
          contexts: ["gitleaks", "typecheck", "build", "neon-preview-branch", "preview-smoke"],
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
