#!/usr/bin/env node
/**
 * Polls Vercel for the preview deployment matching this PR's head commit, and
 * prints its URL once ready.
 *
 * Plain Node + global fetch, matching the rest of the Vercel-facing scripts in
 * this repo. Deliberately does not use the `deployment_status` webhook
 * approach some Vercel-for-GitHub examples use — this workflow is triggered
 * on pull_request, and this script is what makes that self-contained rather
 * than needing a second, event-triggered workflow.
 *
 * required env: VERCEL_TOKEN, VERCEL_PROJECT_ID, GIT_COMMIT_SHA
 * optional env: VERCEL_ORG_ID, TIMEOUT_SECONDS (default 300)
 */
const VERCEL_API = "https://api.vercel.com"
const POLL_INTERVAL_MS = 5000
const TIMEOUT_MS = (Number(process.env.TIMEOUT_SECONDS) || 300) * 1000

const { VERCEL_TOKEN, VERCEL_PROJECT_ID, VERCEL_ORG_ID, GIT_COMMIT_SHA } = process.env

for (const [name, value] of Object.entries({ VERCEL_TOKEN, VERCEL_PROJECT_ID, GIT_COMMIT_SHA })) {
  if (!value) {
    console.error(`missing required env: ${name}`)
    process.exit(1)
  }
}

function vercelUrl(path, params = {}) {
  const url = new URL(`${VERCEL_API}${path}`)
  if (VERCEL_ORG_ID) url.searchParams.set("teamId", VERCEL_ORG_ID)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value)
  return url
}

async function findDeployment() {
  const url = vercelUrl("/v6/deployments", {
    projectId: VERCEL_PROJECT_ID,
    target: "preview",
    limit: "20",
  })
  const response = await fetch(url, { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } })
  if (!response.ok) throw new Error(`list deployments -> ${response.status}`)
  const body = await response.json()

  for (const deployment of body.deployments ?? []) {
    if (deployment.meta?.githubCommitSha === GIT_COMMIT_SHA) return deployment
  }
  return null
}

async function readyState(uid) {
  const url = vercelUrl(`/v13/deployments/${uid}`)
  const response = await fetch(url, { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } })
  if (!response.ok) throw new Error(`inspect deployment ${uid} -> ${response.status}`)
  return response.json()
}

async function main() {
  const deadline = Date.now() + TIMEOUT_MS
  let lastState = "not found yet"

  while (Date.now() < deadline) {
    const summary = await findDeployment()
    if (summary) {
      const detail = await readyState(summary.uid)
      lastState = detail.readyState

      if (detail.readyState === "READY") {
        const url = detail.url.startsWith("http") ? detail.url : `https://${detail.url}`
        console.log(url)
        return
      }
      if (detail.readyState === "ERROR" || detail.readyState === "CANCELED") {
        console.error(
          `deployment ${summary.uid} for ${GIT_COMMIT_SHA} ended in ${detail.readyState}`,
        )
        process.exit(1)
      }
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }

  console.error(
    `timed out after ${TIMEOUT_MS / 1000}s waiting for a preview deployment of ${GIT_COMMIT_SHA} (last state: ${lastState})`,
  )
  process.exit(1)
}

await main()
