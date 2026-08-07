import { APP_STATUSES, type AppStatus } from "./werft-json.ts"

export const DEFAULT_TEMPLATE = "https://github.com/vinoth4v/werft-template.git"

export type Options = {
  name: string | undefined
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
  "no-rollback": "rollback",
  private: "private",
  public: "private",
  yes: "yes",
  help: "help",
} as const

const VALUE_FLAGS = {
  name: "name",
  description: "description",
  dir: "dir",
  template: "template",
  stack: "stack",
  tags: "tags",
  status: "status",
  email: "email",
  password: "password",
} as const

export function parseArgs(argv: readonly string[]): ParseResult {
  const options: Options = {
    name: undefined,
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
    deploy: false,
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
      // --public and --no-rollback are the negative spellings of their keys.
      options[key] = flag !== "public" && flag !== "no-rollback"
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

options:
  --name <name>          app name; also the repo, Neon and Vercel project name
  --description <text>   one line, for the registry card
  --dir <path>           where to write it (default: ./<name>)
  --template <url|path>  template to copy (default: ${DEFAULT_TEMPLATE})
  --stack a,b,c          stack badges (default: read from the template)
  --tags a,b,c           registry tags
  --status <status>       ${APP_STATUSES.join(" | ")} (default: prototype)
  --private | --public   repository visibility (default: private)
  --email <address>      the single operator who may sign in
  --password <password>  hashed locally into .env.local; never transmitted
  --dry-run              do all local work, create no remote resources
  --deploy               also run a production deploy at the end
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
