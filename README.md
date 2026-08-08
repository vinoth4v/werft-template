# werft-template

Template repo for the Werft harness: Next.js App Router, TypeScript strict,
Neon + Drizzle, and a single-user NextAuth gate.

## Getting started

```bash
pnpm install
cp apps/web/.env.example apps/web/.env.local

# fill in .env.local:
openssl rand -base64 32           # -> AUTH_SECRET
pnpm hash-password '<password>'   # -> WERFT_PASSWORD_HASH

pnpm db:migrate
pnpm dev
```

Everything is private by default — you land on `/login`.

Conventions and hard rules live in [AGENTS.md](./AGENTS.md) (`CLAUDE.md` is a
symlink to it).

Scaffolded apps inherit this template's CI, preview pipeline, and Claude Code workflows automatically.
