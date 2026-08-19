# Graph Report - werft-template  (2026-08-18)

## Corpus Check
- cluster-only mode — file stats not available

## Summary
- 502 nodes · 820 edges · 28 communities (23 shown, 5 thin omitted)
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS · INFERRED: 3 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `106c271e`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- scaffold.ts
- compilerOptions
- create-werft-app/package.json
- auth.ts
- tokens/src/index.ts
- create-werft-app/src/index.ts
- retire.ts
- scripts
- operator-password.ts
- biome.json
- scripts
- compilerOptions
- neon-preview-branch.mjs
- tokens/package.json
- kompass.ts
- reap-stale-preview-branches.mjs
- wait-for-preview.mjs
- cli.test.ts
- next-env.d.ts
- migrate.ts
- 0000_audit_log.sql
- { GET, POST }
- create-werft-app/tsconfig.json

## God Nodes (most connected - your core abstractions)
1. `scaffold()` - 38 edges
2. `compilerOptions` - 18 edges
3. `retire()` - 14 edges
4. `scripts` - 14 edges
5. `exec()` - 12 edges
6. `main()` - 12 edges
7. `scripts` - 10 edges
8. `compilerOptions` - 9 edges
9. `Ledger` - 8 edges
10. `resolveVercelToken()` - 8 edges

## Surprising Connections (you probably didn't know these)
- `include` --extends--> `!**/next-env.d.ts`  [EXTRACTED]
  apps/web/tsconfig.json → biome.json
- `exclude` --extends--> `!**/node_modules`  [EXTRACTED]
  apps/web/tsconfig.json → biome.json
- `retire()` --calls--> `deleteNeonProject()`  [EXTRACTED]
  packages/create-werft-app/src/retire.ts → packages/create-werft-app/src/neon.ts
- `scaffold()` --calls--> `setVercelEnv()`  [EXTRACTED]
  packages/create-werft-app/src/scaffold.ts → packages/create-werft-app/src/operator-password.ts
- `scaffold()` --calls--> `exec()`  [EXTRACTED]
  packages/create-werft-app/src/scaffold.ts → packages/create-werft-app/src/exec.ts

## Import Cycles
- None detected.

## Communities (28 total, 5 thin omitted)

### Community 0 - "scaffold.ts"
Cohesion: 0.08
Nodes (39): Ledger, createNeonProject(), deleteNeonProject(), neonDeleteCommand(), NeonKeyCheck, NeonProject, verifyNeonApiKey(), appArchitectureDoc() (+31 more)

### Community 1 - "compilerOptions"
Cohesion: 0.07
Nodes (26): nextConfig, compilerOptions, allowImportingTsExtensions, allowJs, incremental, jsx, lib, paths (+18 more)

### Community 2 - "create-werft-app/package.json"
Cohesion: 0.05
Nodes (41): devDependencies, drizzle-kit, @playwright/test, @types/node, @types/react, @types/react-dom, typescript, vitest (+33 more)

### Community 3 - "auth.ts"
Cohesion: 0.08
Nodes (22): signOutAction(), signInAction(), dynamic, dynamic, authConfig, { handlers, auth, signIn, signOut }, COST, hashPassword() (+14 more)

### Community 4 - "tokens/src/index.ts"
Cohesion: 0.12
Nodes (31): metadata, viewport, outputPath, packageRoot, theme, customPropertyNames(), declarations(), groupsFor() (+23 more)

### Community 5 - "create-werft-app/src/index.ts"
Cohesion: 0.10
Nodes (29): BOOLEAN_FLAGS, DEFAULT_TEMPLATE, helpText(), NEGATIVE_FLAGS, Options, parseArgs(), ParseResult, parse() (+21 more)

### Community 6 - "retire.ts"
Cohesion: 0.11
Nodes (30): AppAwsUser, bucketPolicy(), createAppAwsUser(), deleteAppAwsUser(), extract(), hmac(), iamCall(), listAccessKeys() (+22 more)

### Community 7 - "scripts"
Cohesion: 0.06
Nodes (31): dependencies, drizzle-orm, @neondatabase/serverless, next, next-auth, react, react-dom, @werft/tokens (+23 more)

### Community 8 - "operator-password.ts"
Cohesion: 0.16
Nodes (22): exec(), ExecOptions, ExecResult, quote(), AppOutcome, fetchFleet(), FleetApp, HASH_PATH (+14 more)

### Community 9 - "biome.json"
Cohesion: 0.08
Nodes (23): source, assist, actions, files, formatter, enabled, indentStyle, indentWidth (+15 more)

### Community 10 - "scripts"
Cohesion: 0.10
Nodes (20): engines, node, name, packageManager, private, scripts, build, create-app (+12 more)

### Community 11 - "compilerOptions"
Cohesion: 0.10
Nodes (20): compilerOptions, esModuleInterop, forceConsistentCasingInFileNames, isolatedModules, lib, module, moduleResolution, noEmit (+12 more)

### Community 12 - "neon-preview-branch.mjs"
Cohesion: 0.28
Nodes (14): connectionUri(), create(), createBranch(), del(), deleteVercelPreviewEnv(), env, findBranch(), findVercelEnv() (+6 more)

### Community 13 - "tokens/package.json"
Cohesion: 0.14
Nodes (13): exports, ./tokens.css, files, src, name, private, scripts, build (+5 more)

### Community 14 - "kompass.ts"
Cohesion: 0.19
Nodes (10): Answer, ask(), askOnce(), AskOptions, config(), configSchema, Lane, LANES (+2 more)

### Community 15 - "reap-stale-preview-branches.mjs"
Cohesion: 0.30
Nodes (10): deleteVercelEnvForBranch(), env, githubFetch(), headBranchOf(), main(), neonFetch(), openPrNumbers(), prNumberFromBranchName() (+2 more)

### Community 16 - "wait-for-preview.mjs"
Cohesion: 0.80
Nodes (4): findDeployment(), main(), readyState(), vercelUrl()

### Community 27 - "create-werft-app/tsconfig.json"
Cohesion: 0.11
Nodes (16): ../../tsconfig.base.json, compilerOptions, allowImportingTsExtensions, types, extends, include, node, src/**/*.ts (+8 more)

## Knowledge Gaps
- **187 isolated node(s):** `NeonKeyCheck`, `NeonProject`, `ScaffoldFailure`, `ScaffoldSuccess`, `StepFailure` (+182 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **5 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `includes` connect `compilerOptions` to `biome.json`?**
  _High betweenness centrality (0.031) - this node is a cross-community bridge._
- **Why does `devDependencies` connect `create-werft-app/package.json` to `scripts`?**
  _High betweenness centrality (0.025) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `scaffold()` (e.g. with `.entries()` and `.record()`) actually correct?**
  _`scaffold()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `NeonKeyCheck`, `NeonProject`, `ScaffoldFailure` to the rest of the system?**
  _187 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `scaffold.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.07529411764705882 - nodes in this community are weakly interconnected._
- **Should `compilerOptions` be split into smaller, more focused modules?**
  _Cohesion score 0.07407407407407407 - nodes in this community are weakly interconnected._
- **Should `create-werft-app/package.json` be split into smaller, more focused modules?**
  _Cohesion score 0.04994192799070848 - nodes in this community are weakly interconnected._