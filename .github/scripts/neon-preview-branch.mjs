#!/usr/bin/env node
/**
 * Creates or deletes the Neon branch for a PR's preview environment, and
 * (on create) runs migrations against it and pushes its connection string to
 * Vercel, scoped to that PR's git branch.
 *
 * Plain Node + global fetch, no dependencies — the same pattern as
 * packages/create-werft-app/src/neon.ts and vercel.ts, which this duplicates
 * rather than imports: this script runs directly under `node` in a GitHub
 * Actions runner, outside the pnpm workspace's install step, so it cannot
 * depend on a workspace package being built first.
 *
 * usage:
 *   node neon-preview-branch.mjs create
 *   node neon-preview-branch.mjs delete
 *
 * required env: NEON_API_KEY, NEON_PROJECT_ID, VERCEL_TOKEN, VERCEL_PROJECT_ID,
 * PR_NUMBER, GIT_BRANCH. VERCEL_ORG_ID only when the Vercel project belongs to
 * a team.
 */
import { spawn } from "node:child_process"

const NEON_API = "https://console.neon.tech/api/v2"
const VERCEL_API = "https://api.vercel.com"

const mode = process.argv[2]
if (mode !== "create" && mode !== "delete") {
  console.error(`usage: node ${process.argv[1]} <create|delete>`)
  process.exit(2)
}

const env = requireEnv(
  mode === "create"
    ? [
        "NEON_API_KEY",
        "NEON_PROJECT_ID",
        "VERCEL_TOKEN",
        "VERCEL_PROJECT_ID",
        "PR_NUMBER",
        "GIT_BRANCH",
      ]
    : ["NEON_API_KEY", "NEON_PROJECT_ID", "VERCEL_TOKEN", "VERCEL_PROJECT_ID", "PR_NUMBER"],
)
// Optional for delete: read separately rather than through requireEnv, which
// only carries forward the names it was told are required.
env.GIT_BRANCH ??= process.env.GIT_BRANCH ?? ""

const branchName = `preview/pr-${env.PR_NUMBER}`

function requireEnv(names) {
  const values = {}
  const missing = []
  for (const name of names) {
    const value = process.env[name]
    if (!value) missing.push(name)
    else values[name] = value
  }
  if (missing.length > 0) {
    console.error(`missing required env: ${missing.join(", ")}`)
    process.exit(1)
  }
  return values
}

async function neonFetch(path, init = {}) {
  const response = await fetch(`${NEON_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.NEON_API_KEY}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(
      `Neon ${init.method ?? "GET"} ${path} -> ${response.status}: ${JSON.stringify(body)}`,
    )
  }
  return body
}

function vercelUrl(path) {
  const url = new URL(`${VERCEL_API}${path}`)
  if (env.VERCEL_ORG_ID) url.searchParams.set("teamId", env.VERCEL_ORG_ID)
  return url
}

async function vercelFetch(path, init = {}) {
  const response = await fetch(vercelUrl(path), {
    ...init,
    headers: {
      Authorization: `Bearer ${env.VERCEL_TOKEN}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(
      `Vercel ${init.method ?? "GET"} ${path} -> ${response.status}: ${JSON.stringify(body)}`,
    )
  }
  return body
}

async function findBranch() {
  const body = await neonFetch(`/projects/${env.NEON_PROJECT_ID}/branches`)
  return (body.branches ?? []).find((b) => b.name === branchName) ?? null
}

async function createBranch() {
  const existing = await findBranch()
  if (existing) {
    console.log(`branch ${branchName} already exists (${existing.id}) — reusing it`)
    return existing
  }
  const body = await neonFetch(`/projects/${env.NEON_PROJECT_ID}/branches`, {
    method: "POST",
    body: JSON.stringify({ branch: { name: branchName }, endpoints: [{ type: "read_write" }] }),
  })
  console.log(`created branch ${branchName} (${body.branch.id})`)
  return body.branch
}

async function connectionUri(branchId) {
  const body = await neonFetch(
    `/projects/${env.NEON_PROJECT_ID}/connection_uri?branch_id=${branchId}&database_name=neondb&role_name=neondb_owner`,
  )
  return body.uri
}

function run(command, args, spawnEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env: { ...process.env, ...spawnEnv } })
    child.on("error", reject)
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)),
    )
  })
}

async function findVercelEnv(key) {
  const body = await vercelFetch(`/v10/projects/${env.VERCEL_PROJECT_ID}/env`)
  return (body.envs ?? []).find((e) => e.key === key && e.gitBranch === env.GIT_BRANCH) ?? null
}

async function upsertVercelPreviewEnv(key, value) {
  const existing = await findVercelEnv(key)
  if (existing) {
    await vercelFetch(`/v9/projects/${env.VERCEL_PROJECT_ID}/env/${existing.id}`, {
      method: "PATCH",
      body: JSON.stringify({ value }),
    })
    console.log(`updated Vercel preview env ${key} for branch ${env.GIT_BRANCH}`)
    return
  }
  await vercelFetch(`/v10/projects/${env.VERCEL_PROJECT_ID}/env`, {
    method: "POST",
    body: JSON.stringify([
      { key, value, type: "encrypted", target: ["preview"], gitBranch: env.GIT_BRANCH },
    ]),
  })
  console.log(`created Vercel preview env ${key} for branch ${env.GIT_BRANCH}`)
}

async function deleteVercelPreviewEnv(key) {
  const existing = await findVercelEnv(key)
  if (!existing) {
    console.log(`no Vercel preview env ${key} for branch ${env.GIT_BRANCH} — nothing to remove`)
    return
  }
  await vercelFetch(`/v9/projects/${env.VERCEL_PROJECT_ID}/env/${existing.id}`, {
    method: "DELETE",
  })
  console.log(`deleted Vercel preview env ${key} for branch ${env.GIT_BRANCH}`)
}

async function create() {
  const branch = await createBranch()
  const uri = await connectionUri(branch.id)
  // Masks the connection string in the Actions log. It never leaves this
  // process as a step output or $GITHUB_ENV value — migrations run in this
  // same process, so nothing downstream needs to see it.
  console.log(`::add-mask::${uri}`)

  console.log("running migrations against the preview branch")
  await run("pnpm", ["--filter", "web", "run", "db:migrate"], { DATABASE_URL: uri })

  await upsertVercelPreviewEnv("DATABASE_URL", uri)

  // Vercel starts building the preview the moment the branch is pushed, which
  // is before this job has finished creating the database and setting the
  // variable that points at it. A deployment built in that window has no
  // DATABASE_URL at all — there is deliberately no unscoped preview fallback,
  // because the only value available to be a fallback would be production's —
  // so env() throws and every page answers 500. preview-smoke then fails for a
  // reason that has nothing to do with the change being tested.
  //
  // Measured on a real run: deployment built at 05:23:17, variable set at
  // 05:23:42. Twenty-five seconds, and it had been passing on luck.
  //
  // So any deployment for this branch that predates the variable is rebuilt.
  await redeployStalePreview()
}

/**
 * Redeploys the branch's newest preview if it was built before the environment
 * variable existed.
 *
 * Deliberately quiet about failure: a preview that cannot be redeployed is a
 * problem for the smoke test to report, and turning it into a failure here
 * would fail the database job for something the database job did not do.
 */
async function redeployStalePreview() {
  const url = new URL("https://api.vercel.com/v6/deployments")
  url.searchParams.set("projectId", env.VERCEL_PROJECT_ID)
  url.searchParams.set("limit", "20")
  if (env.VERCEL_ORG_ID) url.searchParams.set("teamId", env.VERCEL_ORG_ID)

  const listed = await fetch(url, {
    headers: { Authorization: `Bearer ${env.VERCEL_TOKEN}` },
  }).catch(() => null)
  if (!listed?.ok) {
    console.log("could not list deployments — leaving the preview alone")
    return
  }

  const body = await listed.json().catch(() => null)
  const mine = (body?.deployments ?? []).filter(
    (deployment) => deployment?.meta?.githubCommitRef === env.GIT_BRANCH,
  )
  const newest = mine[0]
  if (!newest) {
    console.log("no preview deployment for this branch yet — it will build with the variable set")
    return
  }

  const redeploy = await fetch(
    `https://api.vercel.com/v13/deployments${env.VERCEL_ORG_ID ? `?teamId=${env.VERCEL_ORG_ID}` : ""}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.VERCEL_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: newest.name,
        deploymentId: newest.uid,
        target: "preview",
        meta: { werftReason: "rebuilt after its database variable was set" },
      }),
    },
  ).catch(() => null)

  console.log(
    redeploy?.ok
      ? `redeployed ${newest.url} so it can read DATABASE_URL`
      : `could not redeploy ${newest.url}; the smoke test will say so`,
  )
}

async function del() {
  const branch = await findBranch()
  if (!branch) {
    console.log(`branch ${branchName} does not exist — nothing to delete`)
  } else {
    await neonFetch(`/projects/${env.NEON_PROJECT_ID}/branches/${branch.id}`, { method: "DELETE" })
    console.log(`deleted branch ${branchName} (${branch.id})`)
  }

  // GIT_BRANCH may be absent by the time a PR closes if the branch was
  // already deleted by GitHub's own "delete branch on merge" setting — the
  // Vercel env lookup then has nothing to match and is skipped, not an error.
  if (env.GIT_BRANCH) {
    await deleteVercelPreviewEnv("DATABASE_URL")
  } else {
    console.log("GIT_BRANCH not available — skipping the Vercel preview env cleanup")
  }
}

try {
  await (mode === "create" ? create() : del())
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
