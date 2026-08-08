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

**Two real bugs found operating the pipeline after Phase 3–5 were already
built, 2026-08-08 — worth their own entry, since both mean the done-when
above was quietly not fully true until today:**

1. **`drizzle-kit migrate` hung ~60s then failed with no error message, four
   times in a row in GitHub Actions**, against a Neon branch independently
   proven completely healthy: a direct HTTP query returned in 531ms, a
   direct websocket `Pool` query in 1087ms, and the identical `drizzle-kit
   migrate` command run locally against the identical connection string
   succeeded in 2 seconds. The one thing that differed across every failure
   was the GitHub-hosted runner's network path to Neon's websocket proxy —
   `drizzle-kit migrate`'s CLI defaults to a websocket `Pool`, unlike the
   app's own runtime code, which already used the HTTP driver. Fixed by
   switching `db:migrate` to `drizzle-orm/neon-http/migrator`'s own
   `migrate()`, over the same HTTP driver `apps/web/src/db/client.ts`
   already used — verified against the exact branch that had failed 4×,
   applies in ~1s.

2. **Requiring only `preview-smoke` in branch protection does not actually
   enforce anything about the database pipeline.** `preview-smoke` depends
   on `neon-preview-branch` via `needs:`, so when that job fails,
   `preview-smoke` *skips* rather than fails — and GitHub does not treat a
   skipped required check as blocking a merge. Bug #1 above merged into
   `werft-marketplace`'s `main` on the very first attempt, silently, because
   of exactly this gap — `neon-preview-branch`'s repeated failure never
   blocked anything. Fixed by adding `neon-preview-branch` to
   `required_status_checks` directly on every real app (five checks now,
   not four); documented in AGENTS.md so the next app scaffolded gets the
   correct required set from the start.

Both fixes also exercised `reap-stale-preview-branches.yml` for real, on a
genuine (not synthetic) orphaned branch this debugging session produced by
retrying CI against an already-merged PR: triggered manually, it correctly
identified `preview/pr-11` as belonging to a closed PR and deleted it —
confirmed empty afterward. The reap mechanism itself is proven live, not
just unit-reasoned-about.

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

**Status — complete, both paths proven live, 2026-08-08.** `.github/workflows/claude.yml` and `claude-escalate.yml` are merged into the template and into `werft-marketplace` (scaffolded before Phase 3 existed, so it needed the workflows ported by hand — every app scaffolded from now on gets them automatically). One real deviation from the snippet above, found by checking Anthropic's current docs rather than assuming the snippet was current: `ANTHROPIC_MODEL` isn't a variable Claude Code reads. Model selection is `claude_args: "--model ..."`.

**Primary path**, on `werft-template`: filed issue #6, commented `@claude` with a one-line task, and in 50s it pushed a branch with exactly that change and nothing else. Opened the resulting PR and confirmed `pr-checks.yml` genuinely re-triggers on commits from the Claude GitHub App — unlike the default `GITHUB_TOKEN`, whose commits GitHub deliberately doesn't re-trigger workflows on. The App's own reply comment did not re-trigger itself, confirming loop-prevention works. It pushes a branch and links a PR rather than opening one automatically — one more human checkpoint than designed for, not fewer.

**Escalation path**, on `werft-marketplace` (real Neon and Vercel projects, unlike the template): opened a PR with a deliberate build break, confirmed `build`/`typecheck`/`preview-smoke` genuinely failed, then ran `claude-escalate.yml` via `workflow_dispatch` with `model: kompass-hard`. It pushed a new `claude-escalate-pr<n>-<run>` branch — not the original PR's branch — containing exactly the fix and nothing else, verified by diff. Opening a PR from that branch got all four checks green, a real Vercel preview deployment, `preview-smoke` passing against it, and `mergeStateStatus: CLEAN`. Merged; production still serves correctly afterward.

Both halves of the done-when are now met on a real app: an issue becomes a reviewable PR, and a failing PR can be escalated to a stronger model and come back with a working preview URL. Nothing in Phase 3 remains unverified.

---

## Phase 4 — Registry *(weeks 5–6)*

- `werft_apps` table in Neon
- Action on merge to `main`: read `werft.json`, upsert, record deploy timestamp
- Backfill your existing projects: nayoniq, startgrid, carnatic-guitar, mnemo, kompass-iota, kompass-chat
- A nightly Vercel cron that pings each app URL and writes a health flag

**Done when:** every app you own has a row, and stale ones are visibly stale.

**Status — registry live, backfill deliberately incomplete, 2026-08-08.**
`werft_app` table added to `werft-marketplace`'s own database (the "Neon
project you already have" — every scaffolded app has one, so the registry
lives in the one app whose job is to display it, rather than a new shared
project). `POST /api/registry/upsert` (bearer token) validates and upserts;
`registry-upsert.yml`, merged into the template, calls it on every merge to
`main`. `GET /api/registry/health-check` runs nightly via `vercel.json`'s
`crons`.

**Chose HTTP + a shared bearer token over a shared database credential** —
recorded in AGENTS.md, not just here: a raw `DATABASE_URL` in every app's CI
secrets would give every app write access to anything in that table, not
just its own valid `werft.json`, and would put a write-capable credential to
one app's production database in every other app's secrets.

**Two real bugs, both found by testing the deployed endpoints, not by
reading the code:**
- The session gate's proxy matcher exempted `api/auth` but not
  `api/registry` — every request 307'd to `/login`, including ones with a
  correct token, because it never reached the route at all. Every app's CI
  has no session cookie, so this was a complete, silent failure until it was
  tested against the real URL.
- The health-check route failed *open*: `secret && header !== ...` treated
  a missing `CRON_SECRET` as "no check needed," leaving it reachable by
  anyone on the internet. Checked Vercel's own documented pattern before
  shipping the fix — `!secret || header !== ...` — the opposite logic.

Both apps registered themselves for real: `werft-marketplace` and
`werft-template` both have real rows, `werft-template`'s written by
`registry-upsert.yml` running on its own merge, not by hand.

**Backfill — decided, 2026-08-08.** Re-checked the six named apps directly
rather than trusting an earlier, truncated `gh repo list`: `nayoniq`,
`startgrid`, and `carnatic-guitar` are real repos (the first pass missed them
— worth remembering `--limit` truncates); `mnemo` and `kompass-iota` are not
— `gh repo view` returns "Could not resolve to a Repository" for both, so
they were never created under this account, or under a different name.
`kompass-chat` was already real and well-documented.

Backfilled four: `kompass-chat` with its real GitHub description; the other
three had never had a description written anywhere — their READMEs are
unmodified `create-next-app`/Vite boilerplate — so rather than invent one,
each got an explicitly-labeled placeholder ("Pre-Werft app — no description
was ever written for it in the repo.") plus only what could actually be
verified: primary language from GitHub, hosting from the `*.vercel.app`
domain itself, visibility from the repo's real setting, `status: paused` from
push recency (last pushed 6–7 weeks before this was written, no
`werft.json`-driven activity to reset that clock). Confirmed all three
`*.vercel.app` URLs are genuinely live (`200`) before recording them. `mnemo`
and `kompass-iota` are simply not registered — there is nothing real to
attach a row to.

The `paused` status and the honest placeholder aren't a cosmetic choice —
they're the anti-decay function actually working: a row that says "no
description, not touched in seven weeks" is more useful here than a
polished-sounding guess would have been, and doesn't quietly pass off an
invention as fact next to rows that really do have real `werft.json` data
behind them.

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

**Status — built and verified live, Cloudflare Access excluded, 2026-08-08.**
Home page: search, tag-filter pills, a card grid (health dot, stack badges,
a Launch button, or "Not deployed yet" when there's no URL). Detail page at
`/apps/[name]`: every field in plain language — `status` and `health` render
as full sentences ("Prototype — early, may change a lot"), not raw enum
values. Two distinct empty states: zero apps at all gets scaffold
instructions, zero apps matching the current filter gets a specific message
with a one-click "Clear filters."

Not just built — actually looked at, in a real browser, signed in as the
real operator (the browser session from earlier in this work still held):
confirmed the grid renders real data for both registered apps, tag filtering
narrows correctly, the detail page's plain-language labels render as
designed, and the empty-filter state shows the right message with a working
clear action. Added a `success` colour to `@werft/tokens` for the third
health state — `accent` and `danger` already meant something else, and health
dots need three colours for three real states (healthy/unhealthy/unknown).

**Screenshot / repo link:** repo link works (`repoUrl`, derived from the app
name — every scaffolded app's GitHub repo is named identically to the app, so
it doesn't need its own field in `werft.json`). Screenshot is not built —
capturing and storing one is a real, separate feature (needs somewhere to put
the image, and something to trigger the capture), not something to fold in
silently.

**Private apps behind Cloudflare Access — decided, 2026-08-08: deferred, not
faked.** Re-checked for Cloudflare credentials before deciding anything —
still none (`wrangler whoami` unauthenticated, no `CLOUDFLARE_*` env vars, no
config files anywhere on this machine). Configuring Access requires a
Cloudflare account and zone this session cannot obtain; no API or CLI path
exists around that requirement, same as Phase 3's GitHub App install.

The decision: **every app's own NextAuth single-user gate is the real
protection until Cloudflare is configured** — not a fallback pretending to
be Cloudflare, the actual thing Phase 1 built and Part 0 proved works end to
end (real programmatic sign-in, real session cookie, real rejection of a
wrong password). "Private" in the registry (`nayoniq`'s row, for one) means
exactly what it says — a visibility flag reflecting the repo's own setting —
and the UI never claims Cloudflare protection anywhere; the detail page
labels it "Visibility: Private," nothing more. Adding a second network-layer
gate is real, additive security worth doing later, not a currently-missing
piece of what "private" means today.

**When Cloudflare access exists:** the mechanism to add is Access policies on
each private app's own custom domain (not the `*.vercel.app` default, which
Cloudflare can't front) — a manual decision per app, not something to
automate blindly, since it changes how you reach your own apps.

---

## Full-validation pass *(2026-08-08, after all five phases)*

A dedicated hunt for bugs and unfinished pieces across both repos, with every
fix proven live. What it found, and the decisions made:

**The scaffold now arms the CI it ships.** The biggest incomplete module was
hiding in plain sight: `create-werft-app` copied five workflow files into
every new app and set none of their secrets — a pipeline born broken until
wired by hand, despite the scaffold holding every per-project value the
moment provisioning finishes. It now sets `NEON_API_KEY`, `NEON_PROJECT_ID`,
`VERCEL_TOKEN`, `VERCEL_PROJECT_ID` (plus `VERCEL_ORG_ID` for team projects
only), reads the shared `WERFT_REGISTRY_TOKEN`/`KOMPASS_TOKEN` from the
environment or `~/.config/werft/`, and applies five-check branch protection
to public repos — protection deliberately last, since required checks reject
the scaffold's own final push (the same GH006 hit earlier on the template).
Secret values travel on stdin, never argv, where process listings could see
them.

**The first proof-run of that feature found its own race.** Secrets were
initially set *after* the record-URL push — and that push triggers
`registry-upsert.yml`, whose run started two seconds before
`WERFT_REGISTRY_TOKEN` landed, skipped "gracefully," and left the fresh app
silently unregistered. Timestamps in the run log made it undeniable
(workflow start 14:32:34, secret set 14:32:36). Reordered: secrets before
the push, protection alone last. Proof-run #2 confirmed end to end — the
scaffolded app self-registered on the marketplace with its real URL, no
manual step, then was retired through the registry's new removal endpoint
and fully cleaned up. 104s, exit 0, both runs.

**The registry got its missing half.** `DELETE /api/registry/apps/<name>`,
same bearer token as upsert — without a removal path, a retired app's row
lived forever with a red dot, which turns the anti-decay wall into noise.
Proven live: 200 with the row removed, 404 on the repeat, gone from the UI.

**Phase 5's last unbuilt item — the "new app" button — became `/new`**, and
grew into the operator's ask for instructions all over the app: the scaffold
command with a working copy button, the login page explaining the
single-operator model and the real forgotten-password procedure (there is no
reset flow, on purpose), empty states that say what to do next, a detail
page that explains every field in words plus how to work on the app, and a
site footer carrying the one-line mental model. All verified in a real
browser, signed in, on production.

**Smaller real bugs fixed along the way:** no favicon existed anywhere, and
adding one exposed another instance of the gate-vs-ungated-path trap —
Next serves `app/icon.svg` at a URL the closed-by-default matcher 307'd to
`/login`, breaking the tab icon for anyone signed out (now exempted, with an
e2e test, same as `api/registry` before it). Unknown health values rendered
an unlabeled dot with an `undefined` tooltip (now degrade to words, with
screen-reader text). Times rendered via `toLocaleString()`, whose output
depended on which region Vercel scheduled the lambda in (now deterministic
UTC plus a tested relative-time formatter). Tab titles said "Werft app"
everywhere (now real titles per page).

---

## Create-from-the-marketplace *(2026-08-08, evening)*

The operator asked to merge werft-template into the marketplace so apps
could be created from the UI, "highly configurable, including embedding
claude-code cli."

**Merge declined; the goal shipped anyway.** The plan's own top risk is the
template becoming a framework project, and physically merging the repos
would couple every scaffolded app's clone to the marketplace's code. What
the goal actually required was orchestration, not merger: the marketplace's
`/new` page is now a real form (name, description, operator email, tags,
visibility, status, deploy and Vercel-SSO toggles, and a first task) whose
server action dispatches `scaffold-app.yml` in werft-template — the same
`create-werft-app` that runs in a terminal, running in an Actions runner.
One scaffold implementation, two front doors, repos stay decoupled. The
marketplace holds exactly one credential for the whole feature (a
server-only dispatch token behind the session gate); Neon, Vercel and
Kompass secrets never leave werft-template.

**"Embedding claude-code" shipped in its honest form:** the first-task field
becomes an `@claude` issue in the new repo the moment it exists, and Claude
Code — headless in Actions, routed through Kompass via the token the runner
itself armed — starts building before the tab is closed. An interactive CLI
embedded in a web page was not a real deliverable and was not pretended at.

**No password field, deliberately:** dispatch inputs are visible in the run
log on a public repo. The form says so and points at `pnpm hash-password`;
the CLI fold remains the way to set one at scaffold time.

**Proven end to end with a real app born from the real form in a real
browser:** dispatch banner → runner scaffolded repo + database + deploy +
all seven secrets + five-check protection → the app self-registered on the
marketplace with its true URL → the first-task issue produced a Claude
branch containing exactly the requested line and nothing else — verified by
diff — before being retired through the registry's own DELETE endpoint and
full resource cleanup. Zero residue.

**Three defects the live proof caught, all fixed the same hour:**
1. A bare `git push` has no credentials on a runner (`gh auth setup-git` is
   the line a laptop never needed) — and the failure doubled as the ledger's
   first fully-automatic four-resource rollback in a foreign environment:
   "Nothing was left behind."
2. `claude.yml` only listened for comments, but the first-task issue is
   filed by a workflow nobody comments on — Claude sat silent until the
   trigger learned about `issues: opened` with `@claude` in the body.
3. The Vercel CLI credential rotates roughly daily, and a repo secret copied
   from it 403ed the same afternoon (`invalidToken`), briefly blocking a
   merge until refreshed. `resolveVercelToken` now prefers a long-lived
   operator token at `~/.config/werft/vercel-token`, then `VERCEL_TOKEN` in
   the environment, and treats the CLI credential as the interactive-only
   fallback it really is. **Open item, operator-only: mint a long-lived
   token at vercel.com/account/tokens and drop it in that file — until
   then, Vercel-touching CI re-breaks daily and needs the secret refreshed.**

Also that evening: eleven more real apps backfilled into the registry at the
operator's request (loopdeck, sruthiscribe, sruthiscribe-learn, adjutant,
stagegrid, visufinanz, nayoniq-atlas, replforge, editkumpel,
horizon-catalog, ontos) — every URL verified live before recording, real
repo descriptions where they existed, the app's own page title where they
didn't, and nothing invented anywhere. The wall now shows 17 apps, all
health-checked.

---

## The scaffold got configurable — region, storage, look

Four options the operator asked for, each validated against the real APIs
before being built, then wired the whole way through: CLI flag → scaffold →
`scaffold-app.yml` dispatch input → the marketplace's `/new` form. One
implementation, two front doors, no drift (a test asserts the exact input
set the workflow declares).

**Region** (`--region us-east|eu-central|us-west`): one choice co-locates
the database, the functions and the bucket, instead of three
independently-defaulted regions. Every id was probed live — Neon by
creating/deleting a project in each, Vercel by PATCHing
`serverlessFunctionRegion` and reading it back. Omitted means each
provider's own default; existing behaviour unchanged.

**Storage, and the rule that shaped it — "I don't touch the AWS console."**
`--with-s3` doesn't just make a bucket. It mints the app its *own* IAM user
(`werft-<app>`) with an inline policy scoped to exactly that bucket's ARN,
creates that user's access key, and hands the app *that* key. The admin key
lives once, on the werft-template runner (set with `gh secret set`, never
the console), and is never copied into any scaffolded app. Hand-rolled IAM
SigV4 (`iam.ts`), zero dependencies like the S3 signer, and the scoping was
proven the only way that counts: the app's key put/listed its own bucket
and was **denied** listing all buckets or reading another app's bucket. The
IAM user is in the rollback ledger, so a failed scaffold revokes it like
any other resource. Lambda deliberately not provisioned — the fleet's one
function is a bespoke artefact, not a per-app default; the honest move is
the bucket every blob-storing app needs, not a guessed function.

**Theme** (`--theme werft|madras|deck|nordlicht|tinte|kimi-earth|kimi-cocoa|
`kimi-editorial`|`kimi-terminal`): named themes in
`@werft/tokens` — same token *names*, different values, so a theme changes
nothing in any component. madras and deck were sampled from the real
running SruthiScribe and LoopDeck (screenshot → hex); nordlicht and tinte
are designed directions. Written to `theme.json`, which the token build
reads; absent means default, so the template and every pre-theme app build
unchanged. The marketplace picker is visual, per the operator's explicit
"I want the image of the design, not just text": a card per theme, each a
miniature render in that theme's own colours, not a name in a dropdown.

**Default home** `~/Documents/workspace/<name>` for a human running the CLI
— where every other app lives — while the runner keeps its throwaway
checkout (pushed to GitHub, then discarded).

**A lesson paid for twice:** `git reset --hard origin/main` with
uncommitted work discards it. It ate the IAM layer once, silently, between
a merge and a re-sync. The fix wasn't cleverness — it was *commit and push
the branch before running anything that resyncs main*. The second time the
same reset ran, the work was already on its pushed branch and survived
untouched. Recovered fully, committed first, then proven live and cleaned
to zero residue.

---

## The wall learned to speak plainly *(2026-08-08, later)*

The operator's words: *the marketplace description and categories are too
technical. fix it so its more common.* Correct, and the categories were the
worse half.

**The categories weren't categories.** The filter bar was built from `tags`,
and the tags were bookkeeping: `backfilled`, `legacy`, `registry`,
`personal`. Those record how a row arrived in the database, not what the app
is — you could filter the wall by "backfilled", which tells a human nothing
at all. They are now words a person would actually browse by: music, money,
learning, work, data, video, coding, business, ai, tools — and `unfinished`,
which is the honest label for one of them.

**Six descriptions were not descriptions.** They literally read "Pre-Werft
app — no description was ever written for it in the repo." The rest leaned on
jargon: "Enterprise RDF Knowledge Graph Platform", "Germany-native FI
tracker", "generation layer fork of nayoniq (internal codename Atlas)". Every
replacement was read off the app's own live page — its meta description,
headings and copy — rather than remembered or guessed. `carnatic-guitar`
turned out to be an untouched Vite starter (default README, a page rendering
nothing), so it says exactly that and is tagged `unfinished` instead of being
dressed up.

**Cards led with the tech.** Each one listed `next typescript neon drizzle
vercel` under a jargon description. Cards now show what the app *is*; the
stack is still on the app's own page, where someone asking that question
goes.

**A trap on the way in, worth more than the copy change.** The upsert stamped
`lastDeployAt: now()` on every write, and the wall *sorts* by it — so
correcting fifteen descriptions would have claimed fifteen dormant apps
deployed today and reshuffled the whole wall around an edit that deployed
nothing. Hand-editing the table to repair that is forbidden, and rightly, so
the field became optional in the payload instead: CI keeps omitting it (a
merge to main really does deploy, so "now" is true there) and a metadata-only
correction sends the app's real date. Proven on one app and verified in the
database before the other fourteen were touched.

**The marketplace was breaking its own rule.** The registry's law is that a
row is written by CI from the app's own `werft.json`, never by hand — and the
one repo that *defines* that law had no `registry-upsert.yml` at all. Its row
sat frozen at whatever was first inserted, so editing its `werft.json`
changed nothing on the wall: exactly the drift the rule exists to prevent, in
the last place anyone would look for it. It now self-registers like every app
it demands this of, over ordinary HTTP with the shared token.

**Display names.** `name` has to be a GitHub repo, a Neon project, a Vercel
project and a subdomain simultaneously, so it is a slug by necessity and can
never read "SruthiScribe Learn". An optional `title` carries the brand for
display only; nothing resolves by it, and an app that omits it renders
exactly as before. The detail page keeps the slug in mono under the heading,
because that page is where the repo/database/project name is the useful fact.
`--title`, a form field and a workflow input let a new app be branded at
birth instead of edited afterwards.

**Three things that only showed up by doing it:**
1. `werft.json`'s validator rejects unknown keys — by design — and it caught
   `title` instantly by failing on this repo's own file. Both copies of that
   validator (this repo owns the canonical one; the marketplace carries a
   duplicate) were widened together and checked byte-identical, because a
   silent drift between them is a bug that would surface much later and much
   worse.
2. The nullable column went into the production database *before* the code
   that reads it merged. Additive columns are invisible to already-deployed
   code; deploying code that selects a column the database lacks takes the
   wall down.
3. One row still came out untitled, and the reason is a quiet race: the
   marketplace's CI upsert fired while production still ran the old
   validator, which **strips** unknown keys rather than rejecting them — so
   the title vanished with a 200 and no error anywhere. Caught in
   verification, fixed by replaying exactly what the workflow posts. A
   schema-widening deploy racing a CI upsert fails silently; only checking
   the stored result catches it.

Also settled that evening: `stagegrid` and `startgrid` are **not** a
duplicate, which is what they looked like. Both serve 200, under different
titles, from different repos with different commit histories — StageGrid is
an AI assistant for live sound engineers, StartGrid a European
startup-investor platform. Flagged rather than deleted, then checked; the
similar names are a coincidence. All 17 rows are real.

---

## Every session writes down why *(2026-08-08, late)*

The operator's ask: a harness rule that produces documentation an agent and a
human can both use, after every build session, so the logic survives.

**Two documents, and the split is the point.** `docs/ARCHITECTURE.md`
describes the app as it is now — purpose, domain model, data model, surfaces,
external services, decisions in force, known gaps — and is rewritten as the
design changes. `docs/SESSIONS.md` is append-only: what was asked, what
changed, what was decided and why, what was rejected, what is still open.
Conflating them gives you one of two failures — a description that
accumulates history until nobody reads it, or a history that is rewritten
until it records nothing.

**Why it needs saying at all:** the diff already survives in git; the
argument does not. An agent picking an app up months later reads the code
perfectly well and still cannot tell which approaches were tried and
abandoned — which is how work gets redone and decisions get quietly
reversed. Fixed headings, so a reader finds the data model without reading
prose and two sessions do not invent two structures.

**Three places, because a rule in one place is a suggestion:** the hard rule
in AGENTS.md, which every app inherits; the sentence in the issue body that
`@claude` actually reads first, both for a build plan and a change request;
and a `docs` job in pr-checks that fails a PR changing source while
documenting nothing. Test-only, workflow-only and docs-only changes are not
asked to explain themselves.

**A wrinkle worth recording:** scaffolded apps had nowhere to write any of
this. The scaffold deletes werft's own `docs/` as template-internal — rightly
— and left an app with a ten-line README. It now seeds both documents, so the
structure exists before the first feature does. The check accepts any
`docs/*.md` rather than those two names, because this repo keeps its
reasoning in plan.md and inherits the same workflow.

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
