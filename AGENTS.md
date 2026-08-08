# AGENTS.md

Werft template. Single operator, single user, no team. Written by hand — keep it
that way, and keep it short.

## Commands

```
pnpm install
pnpm dev              # Next dev server
pnpm build            # must exit 0 — this is the gate that matters
pnpm test             # Vitest, unit only
pnpm test:e2e         # Playwright smoke — needs `pnpm build` first
pnpm typecheck        # tsc --noEmit
pnpm lint             # Biome check
pnpm format           # Biome check --write
pnpm db:generate      # diff schema -> new SQL migration (no database needed)
pnpm db:migrate       # apply migrations to DATABASE_URL
pnpm hash-password '<password>'   # or pipe it on stdin
pnpm create-app --help            # scaffold a new app from this template
```

## Never do this

- **Never end work on a red build.** `pnpm build` exits 0 or the change is not
  finished. Do not report success from reading the code; report the exit code.
- **Never call a model provider directly.** No `@anthropic-ai/*`, `openai`,
  `@google/*`, or any provider SDK — not in this template, not in an app built
  from it. Model access goes through the Kompass gateway: base URL plus bearer
  token, and the model name is an alias string (`kompass`, `kompass-fast`,
  `kompass-hard`, or blank to let the gateway route) passed straight through.
  The gateway owns lane selection, quota, and cooldown. Never reimplement any of
  that client-side.
- **Never edit a migration that has been applied.** Migrations are append-only.
  Fix forward with a new one.
- **Never read secrets at module scope.** Environment access is lazy so that
  `next build` works without a database or an auth secret.
- **Never add a second user.** The gate is one email and one password hash in
  the environment. A real multi-user app needs a real user store — that is a
  decision to raise, not to implement quietly.
- **Never weaken TypeScript to make an error go away.** No `any`, no
  `@ts-ignore`, no loosening the shared compiler options.
- **Never commit `.env.local`, or a real secret into `.env.example`.**
- **Never put a secret in `werft.json`.** It is committed, the repo may be
  public, and CI reads it into a registry. Connection strings, tokens and keys
  come from the environment.
- **Never leave half-created infrastructure.** Anything that creates a remote
  resource records how to remove it, and on failure either removes it or prints
  the exact command that does.
- **Never print a cleanup command you have not executed successfully.** A
  command that only looks right is worse than no command: it is trusted, fails,
  and the resource survives anyway.
- **Never put Vercel SSO in front of a Werft app by default.** The app's own
  NextAuth gate is the access control. Vercel SSO gates the whole deployment,
  which breaks preview URLs and duplicates protection the app already has.
  Cloudflare Access is the layer for anything needing more. Vercel applies SSO
  to every new project as a team-level default, so it has to be cleared per
  project — `--vercel-sso` opts back in.
- **Never hand-edit generated files** (migrations, `next-env.d.ts`, the token
  stylesheet, lockfile).
- **Never write a raw colour, spacing, or font value into CSS.** Add a design
  token and reference it. A literal in a stylesheet is a token nobody can find.
- **Never let the `@claude` workflow merge a pull request.** It opens or
  updates one; a human merges, always, even when every gate is green. No step
  in `claude.yml` may call `gh pr merge` or equivalent.
- **Never give the `@claude` workflow the production database.** It gets
  nothing beyond `KOMPASS_TOKEN` and the GitHub App's own repo permissions — no
  `NEON_API_KEY`, no `DATABASE_URL`. Whatever it changes gets a real preview
  database the normal way: `pr-checks.yml` already brands every PR with one.

## Blessed dependencies

Everything currently allowed. Anything not on this list needs a human decision
first — say what you want and why, then wait.

- Framework: `next`, `react`, `react-dom`
- Auth: `next-auth`
- Data: `drizzle-orm`, `drizzle-kit`, `@neondatabase/serverless`
- Validation: `zod`
- Design: `@werft/tokens` (in this workspace, no runtime dependencies)
- Tooling: `typescript`, `@biomejs/biome`, `vitest`, `@playwright/test`

Password hashing uses `node:crypto` scrypt. Do not add `bcrypt` or `argon2` —
native build steps break fresh installs.

## What this template can do

- Serve an App Router application, closed by default: every route requires the
  operator's session unless explicitly exempted.
- Authenticate that one operator against a password hash in the environment.
- Talk to a Neon Postgres database through Drizzle, with migrations checked in.
- Record notable events to an append-only audit table, and keep working when
  that write fails.
- Validate its own environment on first use, with an error naming what is
  missing.
- Style itself from a design token package: one TypeScript source of truth that
  generates CSS custom properties, importable both as values and as a
  stylesheet, with light and dark schemes.
- Prove in a browser that the gate closes, without needing a database.
- Describe itself to the Werft registry in `werft.json`, validated against a
  schema that rejects unknown keys and anything shaped like a secret.
- Scaffold a new app from itself: copy, install, build, commit, then create the
  GitHub repository, Neon project and Vercel project — cheapest-to-undo first,
  with a dry run that does every local step and creates nothing remote.
- Gate every pull request on four checks before merge: a secret scan, a
  typecheck, a build that must exit 0, and a Playwright smoke test against that
  PR's real Vercel preview URL.
- Give every pull request its own Neon database branch, migrated and wired to
  its Vercel preview deployment, deleted when the PR closes.

## Phase 2 repository secrets

The PR pipeline (`.github/workflows/pr-checks.yml`, `pr-cleanup.yml`) needs
these as GitHub Actions secrets on the app's repository. None of them belong in
werft.json or any committed file.

| Secret | Where it comes from |
|---|---|
| `NEON_API_KEY` | console.neon.tech → Account → API keys |
| `NEON_PROJECT_ID` | the parent project's ID, printed when `create-werft-app` runs |
| `VERCEL_TOKEN` | vercel.com → Account → Tokens |
| `VERCEL_ORG_ID` | the Vercel team ID, only if the project belongs to a team |
| `VERCEL_PROJECT_ID` | `.vercel/project.json` after `vercel link`, or the Vercel dashboard |

Branch protection on `main` must separately mark the checks as required — the
workflow produces them, but cannot make GitHub enforce them. Requires GitHub
Pro on a private repo (Free rejects the API call outright); a public repo
gets it for free.

**Which checks to require differs by repo.** An app scaffolded from this
template has its own Neon and Vercel projects, so all four
(`gitleaks`, `typecheck`, `build`, `preview-smoke`) belong in
`required_status_checks`. This template repo itself is never deployed — it
has no Neon or Vercel project of its own — so `neon-preview-branch` always
fails there for a structural reason (`missing required env`) and
`preview-smoke` always skips. Requiring either on **this** repo's own `main`
would permanently block every PR here regardless of code quality. Verified by
testing: a PR was genuinely refused by GitHub (`the base branch policy
prohibits the merge`) with all four required, then merged cleanly once the
required set here was narrowed to `gitleaks`, `typecheck`, `build`.

## Phase 3 — remote Claude Code

`@claude` in an issue or PR comment (`.github/workflows/claude.yml`) runs
Claude Code headless in an Actions runner, authenticated as the Claude
GitHub App — install it at github.com/apps/claude, scoped to whichever repos
should get this. Needs one secret:

| Secret | Where it comes from |
|---|---|
| `KOMPASS_TOKEN` | your Kompass deployment; same token works across every app, unlike the Phase 2 secrets, which are per-project |

Commits from the App trigger `pr-checks.yml` normally — unlike the default
`GITHUB_TOKEN`, whose commits GitHub deliberately does not re-trigger
workflows on. A PR this opens gets real gate feedback with no extra wiring.

Describe capabilities, not paths. File paths in agent context go stale and
mislead; find the code by reading it.
