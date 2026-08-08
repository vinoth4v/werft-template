# Werft — Build Plan

A personal harness for building and shipping apps with Claude Code.

**Stack:** GitHub · Vercel · Neon · Cloudflare · Kompass · (S3/Lambda when needed)
**Effort:** ~8 weeks at 6–10 hrs/week
**Scope:** single operator, no team, no auditors

---

## What Werft is

One template repo, one pipeline, one place to see everything you've built.

The bet: most of the time you lose on a side project isn't writing features — it's the first evening of every new repo (auth, database, deploy, CI), plus the slow decay of not remembering what you built six months ago. Werft removes both.

**Non-goals.** Multi-tenancy. Team roles. Compliance artefacts. A plugin system. Anything that only makes sense above ten users.

---

## Architecture

```
GitHub Issue  ──@claude──►  Actions runner (Claude Code headless)
                                    │  ANTHROPIC_BASE_URL → Kompass
                                    ▼
                              branch + PR
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
             Neon branch      Vercel preview     gates
             preview/pr-N     (unique URL)    (4, in CI)
                    │
                    ▼  merge
             prod deploy → registry upsert (Neon)
                                    │
                                    ▼
                          Werft marketplace (Vercel)
```

**Component roles**

| Piece | Role | Notes |
|---|---|---|
| GitHub | Source of truth, task queue (Issues), CI | Free tier is fine at this volume |
| Kompass | All model inference | Nothing calls a provider directly |
| kompass-chat | Chat surface for apps that need one | Reused, not rebuilt per app |
| Vercel | Hosting + preview per PR | Hobby works until you need SSO |
| Neon | App databases **and** the Werft registry | Branch per PR is the key feature |
| Cloudflare | Access in front of private apps; Kompass host | Access is the cheap way to keep things off the open web |
| S3 / Lambda | Blobs; jobs exceeding Vercel's duration limit | Add when you hit the wall, not before |

---

## The registry: don't over-build it

Horizon is a **data** catalog — it models datasets, schemas, and lineage. The registry Werft needs models deployed applications: repo, URL, owner, stack, health, last deploy. Different entity shape. Bending one into the other produces a bad version of both, so Horizon stays out for now.

Backstage is also wrong here — a Postgres-backed Java/Node platform to catalogue your own twenty apps is worse than the problem.

**What you actually need:** a `werft_apps` table in the Neon project you already have.

```
werft.json in each repo          ← you write this once
  { name, description, stack,
    url, tags, status, private }
        │
        ▼  Action on merge to main
  upsert into werft_apps (Neon)
        │
        ▼
  marketplace reads the table
```

About 200 lines total. No new infrastructure, since Neon is already in the stack.

**The Horizon link, later.** Once Werft apps start producing or consuming datasets, register those in Horizon and put a "data" section on the app card pointing at it. That's a genuine integration and a good phase-9 idea. It is not a registry.

---

## Phase 1 — Template repo *(weeks 1–3)*

The only phase that really matters. Everything downstream is plumbing.

**Contents**

- Next.js App Router + TypeScript strict
- Auth: NextAuth, single-user gate by default (you're the only user of most of these)
- Neon + Drizzle, migrations checked in
- Your tokenised design package — even minimal. Agents follow imports, not style guides.
- `werft.json`
- `AGENTS.md`, with `CLAUDE.md` symlinked to it
- Vitest + one Playwright smoke test that actually runs

**AGENTS.md — write by hand.** Generated context files measurably degrade agent performance. Keep it to: build/test commands, the gateway contract (no direct provider calls, ever), the blessed dependency list, and hard "never do this" rules. Describe capabilities, not file paths — paths go stale and poison context.

**Scaffolding:** a `create-werft-app` script (degit + prompts + `gh repo create` + `vercel link` + Neon project via API). Skip Backstage-style templating entirely.

**Done when:** one command gives you a deployed, authenticated app with a working database in under ten minutes.

**Status — complete, 2026-08-08. Done-when met, measured at 87 seconds.**

All three steps done: base scaffold (Next.js 16 App Router, TypeScript strict, Neon + Drizzle with migrations checked in, single-user NextAuth gate on scrypt, Vitest); `@werft/tokens` generating CSS custom properties from one TypeScript source, plus a Playwright smoke test that proves the gate closes; `werft.json` with a validator, and `create-werft-app`. 81 unit tests and 2 browser tests pass; `pnpm -r build` exits 0 from a cold install. AGENTS.md is hand-written with `CLAUDE.md` symlinked to it. The scaffold added no dependencies — `git clone` for degit, `readline/promises` for prompts, `fetch` for the Neon and Vercel APIs.

**Measured.** One command took **87 seconds** from clone to a live production URL, and 84 seconds on a second run — against a ten-minute budget. Both runs went clone → install → Playwright browser → build → commit → GitHub repository → Neon project → migrations applied → Vercel project configured → environment pushed → production deploy → URL recorded in `werft.json`, exit 0.

**Verified on the live deployment**, not inferred: `/` returns 307 to `/login` (the app's own gate), `/login` returns 200 with the sign-in form, `/api/auth/providers` returns real provider JSON — so App Router API routes become working functions — and the generated token stylesheet is served with `--color-bg`, `--space-4` and the dark-scheme block intact. Every throwaway app and its GitHub, Neon and Vercel resources were removed afterwards; no residue.

**What the first real runs cost.** Six defects, none of which local testing could have found: Vercel needs both `rootDirectory` and a `framework` preset set before the first deploy, and `vercel link` sets neither; with `rootDirectory` set Vercel installs at the workspace root — the pnpm link survives, confirmed by `@werft/tokens 0.1.0 <- ../../packages/tokens` in the build log — but runs the app's own build script, so the app now builds its workspace dependency itself rather than relying on an uploaded artefact; the Neon key check hit an endpoint that 404s on this plan; the Vercel CLI writes its token expiry in seconds while it was compared against milliseconds; `vercel project rm` has no `--yes`; and the deploy URL capture swallowed JSON punctuation into `werft.json`. Vercel SSO is now cleared per project — it is a team-level default applied at creation, does not reassert once cleared, and `--vercel-sso` opts back in.

---

## Phase 2 — Preview pipeline *(weeks 3–4)*

The piece that makes free-model output safe to run unattended.

```
PR opened   → Action creates Neon branch preview/pr-N
            → connection string pushed to Vercel preview env
            → migrations run against the branch
            → Playwright smoke test hits the preview URL
PR closed   → Neon branch deleted
```

**The four gates.** Nothing more:

1. `gitleaks` — secret scan
2. `tsc --noEmit` — typecheck
3. `next build` — **exit 0 or the PR stays red**
4. Playwright smoke against the preview URL

Gate 3 is the one that carries the plan. Models don't get to self-report success; CI decides. That was the best idea in kompass-claude and it survives the orchestrator being dropped — enforced more credibly here, because a red check can't be argued with.

**Done when:** a PR from an agent produces a live URL on an isolated database, and a broken build blocks the merge without you looking at it.

---

## Phase 3 — Remote Claude Code *(weeks 4–5)*

**Workflow:** `@claude` on an issue or PR comment triggers Claude Code headless in an Actions runner.

```yaml
env:
  ANTHROPIC_BASE_URL: https://kompass.vinoth4v.workers.dev
  ANTHROPIC_AUTH_TOKEN: ${{ secrets.KOMPASS_TOKEN }}
  ANTHROPIC_MODEL: ${{ inputs.model || '' }}   # blank = auto-route
```

**Guardrails**

- Repo-scoped token, PR-write only — never pushes to `main`
- Agents get Neon preview branches, never the production connection string
- You merge. Always. No auto-merge, even when all four gates are green.

**Escalation without an orchestrator.** Gates red? Re-run the workflow with `ANTHROPIC_MODEL` pinned to a stronger Kompass model. Still red after two attempts? Pull the branch locally and hand it to your Pro session with the failing CI log. Manual, but you're one person — an escalation ladder you check twice a week isn't worth automating.

**Done when:** you file an issue from your phone and get back a reviewable PR with a working preview URL.

**Status — primary path live and proven, 2026-08-08.** `.github/workflows/claude.yml` and `claude-escalate.yml` are merged into the template. One real deviation from the snippet above, found by checking Anthropic's current docs rather than assuming the snippet was current: `ANTHROPIC_MODEL` isn't a variable Claude Code reads. Model selection is `claude_args: "--model ..."` — used by the escalation workflow; the primary path is left unset (auto-route).

Proven with a real run, not inferred: filed issue #6 on `werft-template`, commented `@claude` with a one-line task, and in 50s it pushed a branch with exactly that change and nothing else. Opened the resulting PR (#7) and confirmed `pr-checks.yml` genuinely re-triggers on commits from the Claude GitHub App — `build`, `typecheck`, `gitleaks` all ran and passed for real, `mergeable: MERGEABLE`. The App's own reply comment did not re-trigger itself, confirming the loop-prevention guardrail works. The action pushes a branch and links a PR rather than opening one automatically — one more human checkpoint than designed for, not fewer.

**Not yet proven:** the escalation workflow (`claude-escalate.yml`) — built and merged, modeled on Anthropic's own `ci-failure-auto-fix.yml` example, but never run. The "done when" above needs a working preview URL in the loop too, which issue #6's trivial README fix didn't require — `neon-preview-branch` fails structurally on this repo's own PRs (no Neon/Vercel project of its own, documented in AGENTS.md), so the full loop including a live preview URL is proven on `werft-marketplace`, not here.

---

## Phase 4 — Registry *(weeks 5–6)*

- `werft_apps` table in Neon
- Action on merge to `main`: read `werft.json`, upsert, record deploy timestamp
- Backfill your existing projects: nayoniq, startgrid, carnatic-guitar, mnemo, kompass-iota, kompass-chat
- A nightly Vercel cron that pings each app URL and writes a health flag

**Done when:** every app you own has a row, and stale ones are visibly stale.

---

## Phase 5 — Marketplace *(weeks 6–8)*

A Next.js app on Vercel reading `werft_apps`. Deliberately thin.

- Grid of app cards: name, description, stack badges, health dot, launch button
- Filter by tag and stack; search by name
- Detail view: what it does, screenshot, repo link, last deploy
- Private apps behind Cloudflare Access; public ones open
- One "new app" button that opens the `create-werft-app` instructions

**Not in v1:** ratings, comments, analytics, install flows. You are the only user. Their absence costs nothing.

**Why it earns its place.** Not discovery — you already know what you built. It's the anti-decay function: a wall of apps with health dots makes abandonment visible, which is the thing that actually kills personal project portfolios.

---

## Build order, honestly

| Weeks | Focus |
|---|---|
| 1–3 | Template. Build one **real** app with it, not a demo. |
| 3–4 | Preview pipeline + gates. |
| 4–5 | Remote Claude Code. |
| 5–6 | Registry + backfill. |
| 6–8 | Marketplace. |

**Validation checkpoint at week 5:** scaffold a second real app. If it takes more than fifteen minutes to a deployed URL, fix the template before touching the marketplace. The marketplace is the fun part and the least important one — it is exactly what you'll be tempted to build first.

---

## Where this goes wrong

| Risk | Mitigation |
|---|---|
| Template becomes a framework project | Two real apps built on it before any abstraction |
| Marketplace built before the pipeline works | Phase order is not negotiable |
| Free-model PRs that don't build, endlessly | Gate 3 catches it; two attempts then escalate manually |
| Neon free tier branch limits | Check the cap before phase 2; reap branches on PR close |
| Vercel Hobby limits (you're near the 15 GB sandbox cap) | Clear snapshots before phase 2, or budget for Pro |
| Registry drifting from reality | Populated by CI only. Never hand-edited. |

---

## Monday

1. Create `werft-template` on GitHub.
2. Write `AGENTS.md` by hand. First commit.
3. Pick the first real app to build on it.
