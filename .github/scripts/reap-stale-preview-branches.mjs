#!/usr/bin/env node
/**
 * Deletes any preview/pr-<n> Neon branch (and its Vercel branch-scoped env)
 * whose PR is no longer open.
 *
 * pr-cleanup.yml handles the normal case — a PR closing fires
 * `pull_request: closed`, which deletes that PR's own branch immediately.
 * This script exists for the case that slips past it: when a PR gets
 * superseded and auto-closed by GitHub because another PR (typically
 * claude-escalate.yml's own output, which is deliberately branched off an
 * existing PR's head) merged with the same commits already in it, that
 * auto-close does not reliably fire the same event. Confirmed on a real
 * run: a superseded PR and the PR that superseded it shared the identical
 * closed_at timestamp, and pr-cleanup.yml never ran for the former at all
 * — its Neon branch and Vercel env leaked silently until checked by hand.
 *
 * Run on a schedule, not just reactively, so a missed event self-heals
 * instead of accumulating forever.
 *
 * required env: NEON_API_KEY, NEON_PROJECT_ID, VERCEL_TOKEN, VERCEL_PROJECT_ID,
 * GITHUB_TOKEN, GITHUB_REPOSITORY (owner/repo, as Actions sets it)
 * optional env: VERCEL_ORG_ID
 */
const NEON_API = "https://console.neon.tech/api/v2"
const VERCEL_API = "https://api.vercel.com"
const GITHUB_API = "https://api.github.com"

const env = requireEnv([
  "NEON_API_KEY",
  "NEON_PROJECT_ID",
  "VERCEL_TOKEN",
  "VERCEL_PROJECT_ID",
  "GITHUB_TOKEN",
  "GITHUB_REPOSITORY",
])

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
    headers: { Authorization: `Bearer ${env.NEON_API_KEY}`, "Content-Type": "application/json" },
  })
  if (!response.ok) throw new Error(`Neon ${init.method ?? "GET"} ${path} -> ${response.status}`)
  return response.status === 204 ? null : response.json()
}

function vercelUrl(path) {
  const url = new URL(`${VERCEL_API}${path}`)
  if (env.VERCEL_ORG_ID) url.searchParams.set("teamId", env.VERCEL_ORG_ID)
  return url
}

async function vercelFetch(path, init = {}) {
  const response = await fetch(vercelUrl(path), {
    ...init,
    headers: { Authorization: `Bearer ${env.VERCEL_TOKEN}`, "Content-Type": "application/json" },
  })
  if (!response.ok) throw new Error(`Vercel ${init.method ?? "GET"} ${path} -> ${response.status}`)
  return response.status === 204 ? null : response.json()
}

async function githubFetch(path) {
  const response = await fetch(`${GITHUB_API}${path}`, {
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
  })
  if (!response.ok) throw new Error(`GitHub GET ${path} -> ${response.status}`)
  return response.json()
}

async function openPrNumbers() {
  const prs = await githubFetch(`/repos/${env.GITHUB_REPOSITORY}/pulls?state=open&per_page=100`)
  return new Set(prs.map((pr) => pr.number))
}

/** GitHub keeps a closed PR's metadata, including its head branch name. */
async function headBranchOf(prNumber) {
  const pr = await githubFetch(`/repos/${env.GITHUB_REPOSITORY}/pulls/${prNumber}`)
  return pr.head.ref
}

/** Matches the exact naming create-werft-app's neon-preview-branch.mjs uses. */
function prNumberFromBranchName(name) {
  const match = /^preview\/pr-(\d+)$/.exec(name)
  return match ? Number(match[1]) : null
}

async function deleteVercelEnvForBranch(gitBranch) {
  const { envs } = await vercelFetch(`/v10/projects/${env.VERCEL_PROJECT_ID}/env`)
  const match = envs.find((entry) => entry.key === "DATABASE_URL" && entry.gitBranch === gitBranch)
  if (!match) {
    console.log(`  no Vercel env for branch ${gitBranch} — nothing to remove there`)
    return
  }
  await vercelFetch(`/v9/projects/${env.VERCEL_PROJECT_ID}/env/${match.id}`, { method: "DELETE" })
  console.log(`  removed Vercel env DATABASE_URL for branch ${gitBranch}`)
}

async function main() {
  const open = await openPrNumbers()
  const { branches } = await neonFetch(`/projects/${env.NEON_PROJECT_ID}/branches`)

  const stale = branches
    .map((branch) => ({ branch, pr: prNumberFromBranchName(branch.name) }))
    .filter(({ pr }) => pr !== null && !open.has(pr))

  if (stale.length === 0) {
    console.log(`nothing to reap — ${branches.length} Neon branch(es), all correspond to open PRs`)
    return
  }

  for (const { branch, pr } of stale) {
    console.log(`reaping ${branch.name} (PR #${pr} is closed)`)
    await neonFetch(`/projects/${env.NEON_PROJECT_ID}/branches/${branch.id}`, { method: "DELETE" })

    const gitBranch = await headBranchOf(pr).catch(() => null)
    if (gitBranch) {
      await deleteVercelEnvForBranch(gitBranch)
    } else {
      console.log(`  could not look up PR #${pr}'s head branch — leaving its Vercel env, if any`)
    }
  }
}

await main()
