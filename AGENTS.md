# AGENTS.md

Werft template. Single operator, single user, no team. Written by hand — keep it
that way, and keep it short.

## Commands

```
pnpm install
pnpm dev              # Next dev server
pnpm build            # must exit 0 — this is the gate that matters
pnpm test             # Vitest
pnpm typecheck        # tsc --noEmit
pnpm lint             # Biome check
pnpm format           # Biome check --write
pnpm db:generate      # diff schema -> new SQL migration (no database needed)
pnpm db:migrate       # apply migrations to DATABASE_URL
pnpm hash-password '<password>'
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
- **Never hand-edit generated files** (migrations, `next-env.d.ts`, lockfile).

## Blessed dependencies

Everything currently allowed. Anything not on this list needs a human decision
first — say what you want and why, then wait.

- Framework: `next`, `react`, `react-dom`
- Auth: `next-auth`
- Data: `drizzle-orm`, `drizzle-kit`, `@neondatabase/serverless`
- Validation: `zod`
- Tooling: `typescript`, `@biomejs/biome`, `vitest`

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

Describe capabilities, not paths. File paths in agent context go stale and
mislead; find the code by reading it.
