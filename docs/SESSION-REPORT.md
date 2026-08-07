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
