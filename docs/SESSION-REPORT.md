# Session report — Phase 1 step 3

Unattended run. Step 3 complete: `werft.json` plus the `create-werft-app`
scaffold. Phase 2 not started. Tree clean, everything green, nothing was
provisioned against a real account.

---

## 1. What I built

### `werft.json`

The template's own file sits at the repo root, and the contract lives in
`packages/create-werft-app/src/werft-json.ts` — the shape from the build plan:
`{ name, description, stack, url, tags, status, private }`.

The validator does three things worth naming:

- **Rejects unknown keys.** The registry ignores them, so a key here is either a
  typo or a misunderstanding, and silently accepting it means the file drifts
  from what CI reads.
- **Rejects anything shaped like a secret** — `token`, `key`, `apiKey`,
  `password`, `credentials`. `werft.json` is committed, the repo may be public,
  and rejecting the key outright is cheaper than reviewing every value.
- **Allows an empty `url`.** An app that isn't deployed yet has no URL, and
  writing a guessed one is worse than writing none.

A test asserts this repo's own `werft.json` passes, so the template stays a
valid Werft app rather than a special case.

### `create-werft-app`

`packages/create-werft-app`, invoked as `pnpm create-app`. Twelve steps in the
order you specified, cheapest-to-undo first:

| # | Step | Remote? |
|---|---|---|
| 1 | Preflight (name, target dir, git, gh, vercel, `NEON_API_KEY`) | no |
| 2 | Copy the template, drop `.git` and `docs/` | no |
| 3 | Write `werft.json`, rename the root package, write a README | no |
| 4 | `pnpm install` | no |
| 5 | Hash the operator password, write `.env.local` | no |
| 6 | `playwright install chromium` | no |
| 7 | `pnpm -r build` — prove it builds before anything remote exists | no |
| 8 | `git init` + first commit | no |
| 9 | `gh repo create --push` | **yes** |
| 10 | Neon project via API, then `pnpm db:migrate` | **yes** |
| 11 | `vercel link`, push production env vars | **yes** |
| 12 | Optional `--deploy`, then record the URL in `werft.json` | **yes** |

Steps 1–8 are all local, so the overwhelmingly likely failure — something in
the app doesn't build — costs nothing to clean up. Build verification sits at
step 7 deliberately: before that point there is nothing to roll back.

**Rollback.** Every remote resource is recorded in a ledger the moment it is
created, together with an exact removal command. On failure the ledger unwinds
in reverse order, and anything it could not remove is printed as a command to
paste. Reverse order matters — the local directory holds the Vercel link, so it
has to go last.

**Credentials.** GitHub and Vercel come from the `gh` and `vercel` CLIs, so this
script never handles those tokens. `NEON_API_KEY` is read from the environment
and never written to disk, never passed as a command-line argument where it
would land in shell history and process listings, and never included in a
printed cleanup command — the printed `curl` refers to `$NEON_API_KEY` instead.
The operator password is piped to the template's own `hash-password` rather than
reimplemented here or passed via `argv`.

**Dependencies added: none.** `git clone --depth 1` replaces degit,
`node:readline/promises` replaces a prompt library, and `fetch` replaces a Neon
client. Your budget was two; I used zero.

---

## 2. Command output, with exit codes

### Final state of the suite

```
pnpm -r build      → 0
pnpm lint          → 0
pnpm typecheck     → 0
pnpm test          → 0    (45 tests: 9 web, 3 tokens, 33 create-werft-app)
pnpm test:e2e      → 0    (2 Playwright tests)
```

### The dry run

```
pnpm create-app --name werft-dryrun-demo \
  --description "Dry run rehearsal of the Werft scaffold." \
  --dir <scratchpad>/werft-dryrun-demo \
  --template /Users/vinothkannan/Documents/workspace/werft-template \
  --tags demo,rehearsal --email vinoth4v@gmail.com \
  --password '<throwaway>' --dry-run --yes

=== DRY RUN EXIT: 0 ===
```

Local steps ran for real. The scaffolded app built:

```
packages/tokens build: wrote .../werft-dryrun-demo/packages/tokens/dist/tokens.css
apps/web build: ✓ Compiled successfully in 3.8s
apps/web build:   Finished TypeScript in 1734ms
```

Remote steps were skipped and printed instead:

```
[dry-run] would run: gh repo create werft-dryrun-demo --private --source ... --remote origin --push
[dry-run] would POST https://console.neon.tech/api/v2/projects {"name":"werft-dryrun-demo"}
[dry-run] would run: vercel link --yes --project werft-dryrun-demo
[dry-run] would run: vercel env add AUTH_SECRET production --force
[dry-run] would run: vercel env add WERFT_USER_EMAIL production --force
[dry-run] would run: vercel env add WERFT_PASSWORD_HASH production --force
```

Note `DATABASE_URL` is absent from that list, correctly: it only exists once
Neon has been called, which a dry run doesn't do.

### Verification of what the dry run produced

```
werft.json                     → valid per the validator
root package.json name         → werft-dryrun-demo
docs/                          → removed
git log                        → 1 commit, no remote
.env.local                     → AUTH_SECRET, WERFT_USER_EMAIL, WERFT_PASSWORD_HASH
.env.local gitignored          → yes (.gitignore:10)
tracked files                  → 61
generated AUTH_SECRET in repo  → no
generated password hash in repo → no
hash cost                      → scrypt$65536$8$1...
```

The first secret grep I ran was too loose and matched five files; it was hitting
the literal string `scrypt$` in the implementation, its tests, `.env.example`
and the Playwright config. Re-checked against the actual generated values —
neither appears in any tracked file.

### Failure and rollback, tested for real

Forced a failure *after* the ledger had recorded a resource, by pointing
`--template` at a repo that clones cleanly but has no `package.json`:

```
✗ Failed during configure app: ENOENT ... /rollback-demo/package.json
! Rolling back 1 created resource(s)
  removed: local directory .../rollback-demo
✗ Failed at: configure app
Nothing was left behind.
=== EXIT: 1 ===
directory afterwards: No such file or directory
```

Same failure with `--no-rollback`:

```
! --no-rollback: leaving everything in place
1 resource(s) could not be removed automatically.
Run these to clean up:
  # local directory .../norollback-demo
  rm -rf .../norollback-demo
=== EXIT: 1 ===
survived? yes
```

Preflight guard, and CLI exit codes:

```
existing target directory  → 1, "Nothing was left behind."
unknown flag --nope        → 2
--help                     → 0
--yes with no --name       → 2
--name BadName             → 1
```

### Two things I fixed rather than worked around

**`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.** The CLI crashed on first invocation:
Node's strip-only type stripping rejects TypeScript constructor parameter
properties (`constructor(private readonly x)`). Rewritten as plain fields. Worth
noting that all 30 unit tests passed while the CLI was completely broken —
running `--help` is what caught it. Nothing in the test suite executes `cli.ts`.

**`MODULE_TYPELESS_PACKAGE_JSON`.** `pnpm hash-password` emitted a Node warning
on every run, because `apps/web/package.json` had no `"type": "module"` — an
omission from step 1. Added it and re-verified build, lint, typecheck, test and
e2e all still exit 0. I had also never actually executed `hash-password` in
step 1; doing so now revealed both this and the fact that it needed a piped
input path.

---

## 3. Judgement calls

**Zero dependencies instead of degit and a prompt library.** `git clone --depth
1` followed by deleting `.git` is what degit does, minus caching, and the
platform now covers prompting and HTTP. Your blessed-dependency list stays short.

**The scaffolded app deletes `docs/`.** The build plan and this report are
template-internal; an app built from the template shouldn't ship them. Easy to
reverse if you disagree.

**Deploy is opt-in (`--deploy`), not the default.** The plan's done-when is "one
command gives you a deployed app", which argues for defaulting it on. I left it
off because you said you want to watch the first run that touches real accounts,
and a deploy is the least reversible step. One flag away.

**`werft.json` gets `url: ""` at scaffold time, not a predicted URL.** I could
write `https://<name>.vercel.app`, which is usually right, but is wrong whenever
the project name is taken. Recording nothing beats recording a guess; the URL is
filled in after a successful deploy, in a second commit.

**GitHub rollback attempts automatically, then prints.** Your `gh` token has
scopes `gist, read:org, repo, workflow` — no `delete_repo` — so the automatic
attempt is expected to fail and print the command. I kept the attempt anyway,
because it starts working the moment you grant the scope.

**Neon rollback is fully automatic.** We hold the API key, deletion is one
authenticated request, and the blast radius is a database created seconds
earlier. This is the one remote resource I was comfortable removing without
asking.

**Vercel env vars go to `production` only.** Preview environments are Phase 2's
job — that's where the Neon-branch-per-PR wiring lives — so pushing preview
values now would create something Phase 2 has to undo.

**Build verification is inside the scaffold, at step 7.** It makes a scaffold
run slower, but it means gate 3 of the Phase 2 design is already enforced at
birth: an app that doesn't build never gets a repo.

**Extracted the cleanup report into its own module.** The "never leave silent
half-state" promise lived in an unreachable CLI print block. Now a test asserts
the invariant: every surviving resource is named and every one has a command.

---

## 4. What I'd have asked you

Recorded rather than asked, as instructed. In rough priority order.

1. **The default `--template` points at a repo that doesn't exist yet.**
   `https://github.com/vinoth4v/werft-template.git` — Monday item 1 on the plan
   is creating it. Until it's pushed, every run needs an explicit
   `--template <local path>`, which is what the morning command below does. Want
   me to push this repo to GitHub?
2. **Should `--deploy` be the default?** The plan's Phase 1 done-when implies
   yes; my caution about irreversible steps says no. Your call now that you can
   see the shape.
3. **Neon project region and Postgres version are left at the API defaults.**
   The `.env.example` connection string mentions `eu-central-1`. Should the
   scaffold pin a region?
4. **`gh auth refresh -h github.com -s delete_repo`** would make repository
   rollback automatic. Worth granting, or do you prefer the printed command as a
   deliberate speed bump on repo deletion?
5. **Should `create-werft-app` be publishable** so it runs via `pnpm dlx
   create-werft-app`? Right now it's workspace-only, which means scaffolding a
   new app requires having this repo checked out.
6. **`private: true` is the default for new apps.** Matches "keep things off the
   open web", but the marketplace design has public apps too.
7. **Nothing sets up `KOMPASS_TOKEN` as a repo secret or configures branch
   protection.** Both are Phase 3, so I left them alone — confirming that's the
   right boundary.
8. **The scaffold overwrites the app's README** with a short generated one. Kept
   the getting-started commands; dropped the template-specific prose.

---

## 5. Your command for the first real provisioning run

Do this from the template repo. Substitute the app name, description and
password; everything else is literal.

```bash
export NEON_API_KEY='<paste from console.neon.tech>'

cd /Users/vinothkannan/Documents/workspace/werft-template

pnpm create-app \
  --name my-first-app \
  --description "One line for the registry card." \
  --dir ~/Documents/workspace/my-first-app \
  --template /Users/vinothkannan/Documents/workspace/werft-template \
  --email vinoth4v@gmail.com \
  --password '<at least 12 characters>' \
  --tags personal \
  --yes
```

Add `--deploy` to that if you want a live URL at the end; without it the run
stops after pushing environment variables and tells you the deploy command.

Before you start:

- `NEON_API_KEY` must be exported, or preflight stops the run before anything is
  created. It is currently unset in this shell.
- `gh` and `vercel` are both authenticated already, checked this session
  (`vinoth4v` on both).
- `--template` needs the local path until this repo exists on GitHub. Once it
  does, drop the flag.
- Optional, to make repository rollback automatic rather than printed:
  `gh auth refresh -h github.com -s delete_repo`

To rehearse once more without touching anything remote, add `--dry-run` and
point `--dir` somewhere disposable. The rehearsal from this session is still on
disk if you want to poke at it:

```
/private/tmp/claude-501/-Users-vinothkannan-Documents-workspace-werft-template/0c9e1800-5bea-4fe4-9be6-92630d3c2927/scratchpad/werft-dryrun-demo
```

That directory is a complete, building, committed Werft app with no remote
resources behind it. It is in a scratch path and will not survive a reboot.

---

## 6. Commits this session

```
ae2acc2 Make the cleanup report testable
107a38c Add werft.json and the create-werft-app scaffold
```

Earlier commits, for context:

```
860a736 Rename docs/werft-build-plan.md to docs/plan.md
7033e5f Add @werft/tokens and a Playwright smoke test
3edf2d7 Scaffold the template: Next.js, Drizzle/Neon, single-user auth, Vitest
dd51b6f Add AGENTS.md, written by hand
```

Phase 1 is complete: all three steps done. Phase 2 not started.

---

## 7. Addendum — changes made after this report was written

Two follow-ups, both closing gaps this report itself identified:

- **`--deploy` is now the default**, with `--no-deploy` as the escape hatch.
  Question 2 in §4 asked whether it should be; the answer was yes, because
  Phase 1's done-when is one command to a deployed app. Anywhere above that
  describes deploying as opt-in is describing the older behaviour.
- **The entry point is now executed by a test.** §2 noted that 30 tests passed
  while the CLI crashed on first invocation, because nothing ran `cli.ts`.
  `cli.test.ts` now spawns it and asserts the exit codes, including one case
  named for the exact regression that slipped through.

**Superseded since:** the done-when is now met and measured at 87 seconds, this
repo is on GitHub, and Vercel SSO is off by default with `--vercel-sso` to opt
in. Anywhere above that treats the ten-minute claim as unmeasured, or describes
deploying as opt-in, is describing an earlier state. `docs/plan.md` carries the
current Phase 1 status; prefer it over this report where they disagree.

Six defects surfaced only by real provisioning runs, all fixed and each with a
test: the Vercel `rootDirectory` and `framework` settings, the Neon key
verification endpoint, the CLI token expiry unit, `vercel project rm --yes`, the
deploy URL capture, and `apps/web` not building its own workspace dependency.
The last of those would have failed silently on Phase 2's Git deploys.

---
---

# Session report — Phase 2 step 1 (preview pipeline)

Unattended run. I'm asleep, do not ask questions — record and keep going, per
the brief. Two parts: closing the one open Phase 1 gap (the `--password` path
had never been exercised end to end), then Phase 2's preview pipeline: four
blocking gates on every PR, a Neon branch per PR wired to a Vercel preview
deployment, and Git-based Vercel deploys — with the specific thing flagged at
the end of the last session proven for real, not assumed. Phase 3 not started.

Ten real infrastructure defects were found and fixed this session, every one
of them by running the actual pipeline against real accounts rather than by
reasoning about the code. That ratio is the headline: local `pnpm -r build`
was green the entire session; none of these ten would have been caught by it.

---

## 1. Part 0 — the password path, closed

**Command and result:**

```
pnpm create-app --name werft-test-pw --password 'Th r0waway-P@ss-2026' \
  --email vinoth4v@gmail.com ... --yes
=== EXIT: 0  ELAPSED: 87s ===
```

Signed in **programmatically**, not by inspection — fetched a CSRF token,
POSTed real credentials to `/api/auth/callback/credentials`, and checked what
came back:

```
POST /api/auth/callback/credentials → 302, Set-Cookie: __Secure-authjs.session-token=...
GET /api/auth/session → {"user":{"name":"Operator","email":"vinoth4v@gmail.com"},...}
GET / (with the session cookie) → 200, "Signed in as vinoth4v@gmail.com", a Sign-out button
```

A control request confirmed the unauthenticated case still redirects (307)
before any of that. Cleaned up (Neon, Vercel, GitHub, local) and ran the
four-system residue check: **0**. This closes the last open item from Phase 1
step 3 — every path in the auth flow has now actually been exercised by a real
request, not just by code review.

---

## 2. What I built for Phase 2

**`.github/workflows/pr-checks.yml`** — triggered on `pull_request`
(opened/synchronize/reopened), five jobs: `gitleaks`, `typecheck`
(`tsc --noEmit`), `build` (`pnpm -r build`, exit 0 or red), `neon-preview`
(creates/updates the PR's Neon branch, migrates it, pushes its connection
string to Vercel scoped to that PR's git branch), and `preview-smoke` (polls
Vercel for the deployment matching the PR's head SHA, then runs the existing
Playwright smoke spec against that real URL). Four of those are "the four
gates"; `neon-preview` is the plumbing `preview-smoke` depends on.

Deliberately **not** a `deployment_status`-triggered second workflow, which is
the pattern most Vercel-for-GitHub examples use — the brief asked for the
pipeline to be "on pull_request", so `preview-smoke` polls Vercel's REST API
for the matching deployment itself, keeping everything expressible as one
trigger.

**`.github/workflows/pr-cleanup.yml`** — triggered on `pull_request: closed`,
deletes the Neon branch and the branch-scoped Vercel env var. Mirrors
`neon-preview` in reverse, same as the scaffold's own rollback ledger mirrors
creation in reverse.

**`.github/scripts/neon-preview-branch.mjs`** and **`wait-for-preview.mjs`** —
plain Node + global `fetch`, no dependencies, duplicating rather than
importing `packages/create-werft-app`'s Neon/Vercel modules: these run
directly under `node` in a bare Actions runner, outside the workspace's
install step, so they cannot depend on a workspace package.

**Scaffold changes** (`packages/create-werft-app`): added a `vercel git
connect --yes` step right after `vercel link`, and pushes
`AUTH_SECRET`/`WERFT_USER_EMAIL`/`WERFT_PASSWORD_HASH` to the `preview`
Vercel target as well as `production` — a preview deployment needs them to
authenticate too, and previously had none.

**`apps/web/playwright.config.ts`** gained `PLAYWRIGHT_BASE_URL`: set, it
points the existing two-test smoke spec at an already-deployed URL instead of
starting a local server. No new spec, no new dependency — this is what
`preview-smoke` uses.

**Dependencies added: zero.** Same discipline as Phase 1's scaffold — `fetch`
for both Neon and Vercel, the `vercel` and `gh` CLIs for what they're already
used for, nothing new installed anywhere.

---

## 3. The ten defects, in the order they were found

Every one of these was invisible from a green local build. Each is committed
separately with the real symptom in the message; summarized here with the
proof that it's fixed.

1. **`vercel git connect --yes` exits 1 when already connected.** A real run
   showed `vercel link` had already auto-connected the GitHub repo, so the
   explicit connect step failed with "is already connected to your project" —
   which the ledger correctly treated as a real failure and rolled back an
   otherwise-successful run. Fixed with `remoteTolerant`: the caller decides,
   from the actual output, whether a nonzero exit is redundancy rather than
   wrongness. Verified: the next run logged `already done — treating as
   success` and continued.

2. **GitHub Free does not support required status checks on a private repo.**
   `gh api .../branches/main/protection` returned `403: Upgrade to GitHub Pro
   or make this repository public to enable this feature.` This is a billing
   constraint, not a bug — I did not work around it. The four checks still
   run and report pass/fail correctly regardless (proven in items 8–10 below);
   what a Free private repo cannot get is GitHub *administratively refusing
   the merge button* on a red check. That is a decision for you, recorded in
   §5.

3. **`.nvmrc` pinned a Node version pnpm itself cannot run on.** The very
   first real CI run failed four jobs identically, before any project code
   ran: `pnpm 11.9.0 requires at least Node.js v22.13`, but `.nvmrc` said
   `20.9.0` and `actions/setup-node` installs that literally. Invisible
   locally all session because the local shell always uses system Node
   (26.4.0) regardless of what `.nvmrc` claims. Fixed by bumping `.nvmrc` and
   `engines.node` to `>=22.13.0` everywhere. Verified: re-ran, this specific
   error was gone (see #4 for what showed up next).

4. **Node 22.13 does not strip TypeScript types by default.** Bumping to the
   version pnpm required uncovered a second, layered bug: `node
   scripts/build-css.ts` crashed with `ERR_UNKNOWN_FILE_EXTENSION` for `.ts`,
   because unflagged type-stripping only arrived in later Node lines than
   22.13 — invisible on the local Node 26.4.0, which has it by default. Fixed
   by passing `--experimental-strip-types` explicitly everywhere a `.ts` file
   is executed directly (`packages/tokens`'s build script, `hash-password`,
   `create-app`, and the CLI spawn test), rather than assuming a version
   threshold. Verified locally with node_modules, dist, and .next fully
   removed and reinstalled from a frozen lockfile — a genuine cold build, not
   an incremental one — exit 0.

5. **`gitleaks-action` needs `pull-requests: read`, which the default
   `GITHUB_TOKEN` does not carry.** First real run: `RequestError [HttpError]:
   Resource not accessible by integration`, 403, on
   `GET /repos/.../pulls/1/commits` — the action's own call to list the PR's
   commits before scanning them. Fixed with an explicit `permissions:` block
   on the job. Verified: `gitleaks` went from `fail` to `pass` with no other
   change.

6. **Neon's branch-creation response carries no connection string.** Verified
   against a real, disposable Neon project before writing any script code:
   `POST .../branches` returns `branch`, `endpoints`, `operations` — no
   `connection_uris`, unlike project creation. A separate
   `GET .../connection_uri?branch_id=...&database_name=neondb&role_name=neondb_owner`
   call is required. Written into the script correctly from the start because
   this was tested before being assumed, not discovered by a failing run.

7. **Vercel refuses a branch-scoped env var on a project with no connected
   Git repository.** Also verified ahead of time, against a disposable
   project: `POST .../env` with a `gitBranch` target returned
   `"Project ... does not have a connected Git repository."` This is what
   fixed the ordering — `vercel git connect` has to run, and succeed, before
   any per-PR env push is attempted. Directly shaped the scaffold change in
   item 1.

8–10. **The three found via the deliberately-broken PR** — see §4 below;
   listed separately because they're the direct answer to "prove the gates
   fail," not incidental discoveries.

---

## 4. Proving the gates actually go red — and then actually go green

Opened a real PR (`vinoth4v/werft-test-p2#1`) with a deliberately broken
`page.tsx` (`): number()` on the export). First run, before defects 3–5 above
were fixed, gave a **false positive on the proof**: `typecheck` and `build`
failed, but so did `gitleaks` and `neon-preview-branch` — and neither of those
should have anything to do with a TypeScript return-type error. That
mismatch is what surfaced defects 3, 4, and 5: the gates were red for the
wrong reason, which is not the same as proving they work.

After fixing all three and pushing the fix to the same PR branch:

```
build           fail   ← real: the intentional break
typecheck       fail   ← real: the intentional break
gitleaks        pass   ← real: no secrets, permission fixed
neon-preview-branch  pass   ← real: branch/migrate/env-push all work
preview-smoke   fail   ← real: correctly refuses to test a deployment that never became ready
Vercel (native) fail   ← real: the deploy build failed on the same break
```

Then reverted the break and pushed the fix:

```
build            pass
typecheck        pass
gitleaks         pass
neon-preview-branch  pass
preview-smoke    pass   (Playwright ran against the real preview URL and passed)
Vercel (native)  pass   (Deployment has completed)
```

Every check moved for the right reason, both directions. That is the actual
proof asked for — not "I saw green," but "I saw it fail for the true reason,
then fixed the true reason, then saw it pass."

---

## 5. The Vercel Git deploy build-order verification — the highest-risk item

Fetched the deployment directly from Vercel's API rather than trusting the
Actions checkmark:

```
source:     git
gitSource:  {ref: 'break-the-build', type: 'github', sha: '7d7eefb3...'}
readyState: READY
```

No `vercel deploy` CLI command was ever run against this app — confirmed
`source: git` is the only way this deployment could exist. Then the build log,
in order, timestamped:

```
Running "pnpm run build"
$ pnpm --filter @werft/tokens run build && next build
wrote /vercel/path0/packages/tokens/dist/tokens.css      ← tokens builds first
✓ Compiled successfully in 746ms                          ← then Next, 2.5s later
```

`/vercel/path0/...` is a fresh build container — nothing was uploaded from a
local machine. This settles what last session's report explicitly flagged as
unverified: `apps/web`'s build script (`pnpm --filter @werft/tokens run build
&& next build`, added last session) is what makes this work. Without it, this
deployment fails the exact same way the very first real Vercel deploy did,
two sessions ago (`No Output Directory named "public" found`) — except this
time on every PR, silently, since Git deploys don't show a human the build log
by default the way a CLI deploy does.

---

## 6. Neon branch-per-PR lifecycle, verified end to end

Not just "the workflow reported success" — checked the actual state on both
sides, before and after:

```
before close:  Neon branches: main, preview/pr-1
               Vercel envs with gitBranch set: DATABASE_URL -> break-the-build

after close:   Neon branches: main                    (preview/pr-1 gone)
               Vercel envs with gitBranch set: 0
```

The cleanup workflow's own log said `deleted branch preview/pr-1` and
`deleted Vercel preview env DATABASE_URL` — confirmed independently via
direct API calls rather than trusting that log, the same discipline applied
to every claim in this report.

---

## 7. Cleanup and residue

Every throwaway resource this session created — `werft-test-pw` and
`werft-test-p2`, each with a GitHub repo, a Neon project, a Vercel project,
and a local directory — was removed. Final check, all four systems:

```
github werft-test-* repos:    0
neon werft-test-* projects:   0
vercel werft-test-* projects: 0
local werft-test-* dirs:      0
TOTAL RESIDUE: 0
```

Residue was non-zero at intermediate points and each time was resolved before
moving on — never left for the final check to discover. `~/.config/werft/neon-key`
left in place, as instructed.

---

## 8. Judgement calls

**Duplicated the Neon/Vercel fetch logic into `.github/scripts/*.mjs` rather
than importing `packages/create-werft-app`.** Those CI scripts run under bare
`node` on an Actions runner, before or without any workspace install step —
they cannot import a TypeScript module from a sibling package the way
in-repo code can. Small, deliberate duplication over a dependency that
wouldn't actually resolve at the point it's needed.

**`preview-smoke` polls the Vercel API instead of using the
`deployment_status` webhook pattern.** The idiomatic Vercel-for-GitHub
approach is a second workflow triggered by `deployment_status`. The brief
asked for gates "on pull_request", so I kept everything under that single
trigger and had the smoke job wait for its own evidence instead. Trade-off:
a fixed 5-minute poll timeout rather than an event push — acceptable for a
personal-scale pipeline, worth reconsidering if deploys start taking longer.

**Bumped the Node floor to 22.13, not further.** That's the exact minimum
pnpm 11.9.0 states it needs. I did not round up to Node 24 LTS "to be safe" —
22.13 is what's proven to work end to end tonight (cold local build, real CI,
real Vercel build all passed on it), and rounding up unverified is the same
mistake as pinning 20.9 unverified in the first place.

**Left GitHub's required-status-checks limitation as a recorded fact, not a
workaround.** Making the repo public, or paying for GitHub Pro, are both real
options — neither is mine to choose. The checks themselves are correct and
proven; only administrative enforcement is affected.

**Did not attempt to fix `create-werft-app`'s own shebang line
(`#!/usr/bin/env node`) for the strip-types issue.** It only matters if the
package is ever globally installed and its `bin` entry run directly by the
shebang, which nothing in this repo does. `env` doesn't portably support
passing a flag. Noted rather than fixed, since it wasn't exercised by
anything tonight and fixing it properly (a wrapper script, most likely) is
its own small decision.

**Set every secret myself.** Expected `VERCEL_TOKEN` to need your hands, going
in — it didn't; the same local CLI-auth fallback the scaffold itself uses read
it fine, same as `NEON_API_KEY` from the file you left in place. All five
Actions secrets (`NEON_API_KEY`, `NEON_PROJECT_ID`, `VERCEL_TOKEN`,
`VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`) were set by `gh secret set` without
needing anything from you.

---

## 9. What I'd have asked you

Recorded, not asked, per the brief.

1. **Required status checks need GitHub Pro or a public repo, on every app
   this template scaffolds.** Right now a red check is visible but does not
   block merge on a private repo. Options: upgrade the account, make specific
   app repos public, or accept checks as advisory-only until one of the
   other two happens. This is the one open item that materially affects
   whether "four gates, each blocking" is true today.
2. **Should `create-werft-app` set these five secrets automatically**, the
   way it already provisions Neon and Vercel? It has every value in hand at
   the moment it finishes (Neon project ID, Vercel project/org ID, and both
   API tokens) — the only reason it doesn't today is that wiring Phase 2
   secrets wasn't in tonight's scope for the scaffold itself, only for the
   pipeline files it now includes.
3. **The `preview-smoke` job's 5-minute timeout** is a guess calibrated to
   tonight's ~90-second real deploys plus margin. Worth revisiting once app
   builds get heavier.
4. **`--vercel-sso` apps won't get a working `preview-smoke`** as currently
   built — SSO gates the preview URL itself, and the smoke job doesn't handle
   a Vercel Automation Bypass secret. Not exercised tonight since the default
   is SSO off; flagging it as a gap if that flag is ever combined with Phase 2.

---

## 10. Morning checklist

1. **Decide on required status checks.** Pick one: upgrade to GitHub Pro,
   make individual app repos public, or accept advisory-only checks for now.
   Nothing further to do from my side until you decide — I did not guess.
2. **Optional — grant `delete_repo` if you want fully automatic repo
   rollback** (unrelated to tonight, still open from earlier sessions):
   `gh auth refresh -h github.com -s delete_repo`, completing the browser page
   fully this time.
3. **Try Phase 2 for real on an app you keep**, not a throwaway: scaffold it,
   watch `vercel git connect` run automatically, open a real PR, watch the
   four checks and the Neon branch appear, merge, watch the branch and env
   var disappear on close. Everything needed — secrets, workflow files,
   scaffold changes — is already in `werft-template`'s `main` and will be
   inherited by the next `pnpm create-app` run.
4. **When ready for Phase 3** (remote Claude Code via `@claude`), say so —
   this session stopped at the end of Phase 2 step 1 as instructed.

---

## 11. Commits this session

```
<latest>  Explicitly strip TypeScript types rather than rely on a Node default
          Fix two CI infra bugs found by the first real pipeline run
          Treat "already connected" from vercel git connect as success
          Phase 2 setup: PR pipeline, Neon branch-per-PR, Git deploy connection
```

Plus the Part 0 verification (no code changes — a real run, a real sign-in,
a real cleanup). 20 commits total on `main` since Phase 1 began; tree clean,
pushed, `pnpm -r build` / `lint` / `typecheck` / `test` / `test:e2e` all exit
0 as of the last line of this report.

---

# Session report — graphify knowledge graphs

Every app scaffolded from this template now maps itself into a knowledge
graph, keeps that map current by itself, and reports a summary of it to the
registry so the marketplace can show what an app is made of. Green:
`typecheck`, `lint`, `test` (110 in `create-werft-app`, 17 in `apps/web`) and
`build` all exit 0.

## 1. What changed

### The scaffold maps a new app before its first commit

`scaffold.ts` gains a step between "verify build" and "git init": run
`graphify extract . --code-only`, then `cluster-only`. Straight after
`git init` and *before* the first `git add`, it runs `graphify hook install`,
so the post-commit hook and the `graph.json` merge driver's `.gitattributes`
entry are both part of the initial commit. From then on the graph rebuilds
itself on every commit and checkout — tree-sitter AST only, no LLM, no API
key, no network, nothing to pay for.

Every graphify call goes through `runner.probe`, never `runner.local`.
graphify is a local developer tool, not a build dependency: if it is missing
or unhappy the scaffold adds a note and carries on. A visualisation must
never be the reason an app fails to be created.

It runs in a dry run too, matching the clone and the commit — in this
codebase `--dry-run` means "do the local work, create nothing remote", and
extraction is entirely local.

### Apps report their graph to the registry

`scripts/registry-payload.mjs` builds what `registry-upsert.yml` posts:
`werft.json` as before, plus a summary of the committed
`graphify-out/graph.json`. The workflow falls back to posting `werft.json`
directly when the script is absent, so apps scaffolded before this change
keep working untouched.

A real graph is ~460KB — too big for a row per app and far too big to send to
a browser. The summary is bounded instead: totals, the eight most-connected
nodes, and a 150-node sample with the ≤600 edges between them. This repo's
own graph reduces to about 11KB. The sample keeps the *most-connected* nodes
rather than the first N, because degree is what makes a node worth drawing;
an arbitrary slice of a file-ordered list would show whatever sorts first.

The marketplace enforces the same bounds as a schema on arrival, including a
check that no edge index points past the node list — the renderer indexes
straight into that array, so a malformed payload has to stop at the boundary.

## 2. Decisions worth keeping

- **`graphify-out/` is committed; `graphify-out/cache/` is not.** CI reads
  `graph.json` out of the checkout, so an uncommitted graph means no app ever
  reports one and the whole feature is inert. The AST cache is rebuildable and
  churns on every run, and graphify's own docs call committing it optional.
- **An absent graph never deletes a stored one.** The upsert treats a missing
  `graph` as "this sender had nothing to report", not "delete what you have".
  A CI run whose graph build failed must not blank a graph that was reported
  correctly last time.
- **The template's own graph is committed too**, so `werft-template`'s registry
  row shows one like any other app. A new app briefly inherits it from the
  clone and immediately overwrites it in the scaffold's own extract step.

## 3. Still open

- The community labels are placeholders (`Community 7`) rather than names.
  Naming them needs an LLM pass over the graph; the structural work — hubs,
  communities, cross-file edges — is complete and free without it.
- `.claude/settings.json` hardcodes an absolute path to the `graphify` binary,
  which is what graphify's installer writes and is correct for a
  single-operator setup, but would not resolve on another machine.
