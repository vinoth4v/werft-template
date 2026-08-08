import { REGION_KEYS, type RegionKey } from "./regions.ts"
import { APP_STATUSES, type AppStatus } from "./werft-json.ts"

// Mirrors @werft/tokens' THEME_NAMES; duplicated because this package stays
// zero-dependency and cannot import a workspace sibling at runtime. The
// scaffold validates the copy against the template's real themes.ts anyway.
export const THEME_KEYS = [
  "werft",
  "madras",
  "deck",
  "nordlicht",
  "tinte",
  "kimiEarth",
  "kimiCocoa",
  "kimiEditorial",
  "kimiTerminal",
] as const
export type ThemeKey = (typeof THEME_KEYS)[number]

export const DEFAULT_TEMPLATE = "https://github.com/vinoth4v/werft-template.git"

export type Options = {
  name: string | undefined
  title: string | undefined
  description: string | undefined
  dir: string | undefined
  template: string
  stack: string[] | undefined
  tags: string[]
  status: AppStatus
  private: boolean
  email: string | undefined
  password: string | undefined
  dryRun: boolean
  skipInstall: boolean
  skipBrowsers: boolean
  deploy: boolean
  vercelSso: boolean
  region: RegionKey | undefined
  withS3: boolean
  theme: ThemeKey
  rollback: boolean
  yes: boolean
  help: boolean
}

export type ParseResult = { ok: true; options: Options } | { ok: false; error: string }

const BOOLEAN_FLAGS = {
  "dry-run": "dryRun",
  "skip-install": "skipInstall",
  "skip-browsers": "skipBrowsers",
  deploy: "deploy",
  "no-deploy": "deploy",
  "vercel-sso": "vercelSso",
  "with-s3": "withS3",
  "no-rollback": "rollback",
  private: "private",
  public: "private",
  yes: "yes",
  help: "help",
} as const

/** Spellings that set their flag false rather than true. */
const NEGATIVE_FLAGS = new Set(["public", "no-deploy", "no-rollback"])

const VALUE_FLAGS = {
  name: "name",
  title: "title",
  description: "description",
  dir: "dir",
  template: "template",
  stack: "stack",
  tags: "tags",
  status: "status",
  email: "email",
  password: "password",
  region: "region",
  theme: "theme",
} as const

export function parseArgs(argv: readonly string[]): ParseResult {
  const options: Options = {
    name: undefined,
    title: undefined,
    description: undefined,
    dir: undefined,
    template: DEFAULT_TEMPLATE,
    stack: undefined,
    tags: [],
    status: "prototype",
    private: true,
    email: undefined,
    password: undefined,
    dryRun: false,
    skipInstall: false,
    skipBrowsers: false,
    // On by default: Phase 1 is done when one command gives a deployed app.
    deploy: true,
    // Off by default: the app's own gate is the access control, and Vercel SSO
    // in front of the whole deployment would break Phase 2 preview URLs.
    vercelSso: false,
    region: undefined,
    withS3: false,
    theme: "werft",
    rollback: true,
    yes: false,
    help: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === undefined) continue

    if (argument === "-h") {
      options.help = true
      continue
    }

    if (!argument.startsWith("--")) {
      return { ok: false, error: `unexpected argument "${argument}"` }
    }

    const separator = argument.indexOf("=")
    const flag = (separator === -1 ? argument.slice(2) : argument.slice(2, separator)).toLowerCase()
    const inlineValue = separator === -1 ? undefined : argument.slice(separator + 1)

    if (flag in BOOLEAN_FLAGS) {
      if (inlineValue !== undefined) {
        return { ok: false, error: `--${flag} does not take a value` }
      }
      const key = BOOLEAN_FLAGS[flag as keyof typeof BOOLEAN_FLAGS]
      options[key] = !NEGATIVE_FLAGS.has(flag)
      continue
    }

    if (!(flag in VALUE_FLAGS)) {
      return { ok: false, error: `unknown flag --${flag}` }
    }

    let value = inlineValue
    if (value === undefined) {
      index += 1
      value = argv[index]
    }
    if (value === undefined || value === "") {
      return { ok: false, error: `--${flag} needs a value` }
    }

    const key = VALUE_FLAGS[flag as keyof typeof VALUE_FLAGS]
    if (key === "stack" || key === "tags") {
      options[key] = value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "")
      continue
    }
    if (key === "status") {
      if (!APP_STATUSES.includes(value as AppStatus)) {
        return { ok: false, error: `--status must be one of: ${APP_STATUSES.join(", ")}` }
      }
      options.status = value as AppStatus
      continue
    }
    if (key === "region") {
      if (!REGION_KEYS.includes(value as RegionKey)) {
        return { ok: false, error: `--region must be one of: ${REGION_KEYS.join(", ")}` }
      }
      options.region = value as RegionKey
      continue
    }
    if (key === "theme") {
      if (!THEME_KEYS.includes(value as ThemeKey)) {
        return { ok: false, error: `--theme must be one of: ${THEME_KEYS.join(", ")}` }
      }
      options.theme = value as ThemeKey
      continue
    }
    options[key] = value
  }

  return { ok: true, options }
}

export function helpText(): string {
  return `create-werft-app — scaffold a Werft app

usage:
  create-werft-app --name <app-name> [options]

what it does, cheapest-to-undo first:
  1. copy the template locally, install, build
  2. git init and commit
  3. create the GitHub repository and push
  4. create the Neon project
  5. create and link the Vercel project, push environment variables
  6. deploy to production, and record the URL in werft.json

options:
  --name <name>          app name; also the repo, Neon and Vercel project name
  --title <text>         display name, e.g. "My App" (default: the name itself)
  --description <text>   one line, for the registry card
  --dir <path>           where to write it (default: ~/Documents/workspace/<name>)
  --template <url|path>  template to copy (default: ${DEFAULT_TEMPLATE})
  --stack a,b,c          stack badges (default: read from the template)
  --tags a,b,c           registry tags
  --status <status>       ${APP_STATUSES.join(" | ")} (default: prototype)
  --private | --public   repository visibility (default: private)
  --email <address>      the single operator who may sign in
  --password <password>  hashed locally into .env.local; never transmitted
  --dry-run              do all local work, create no remote resources
  --no-deploy            stop after pushing environment variables
  --vercel-sso           put Vercel SSO in front of the whole deployment
  --region <key>         where it lives: ${REGION_KEYS.join(" | ")} — one choice
                         co-locating database, functions and bucket (default:
                         each provider's own default)
  --with-s3              provision a per-app S3 bucket and wire AWS env vars
  --theme <name>         design theme: ${THEME_KEYS.join(" | ")} (default: werft)
  --skip-install         do not run pnpm install
  --skip-browsers        do not run playwright install chromium
  --no-rollback          on failure, print cleanup commands but change nothing
  --yes                  never prompt; fail if something required is missing
  -h, --help             this text

environment:
  NEON_API_KEY           required unless --dry-run. Never written to the repo.

credentials for GitHub and Vercel come from the gh and vercel CLIs.
`
}
