#!/usr/bin/env node
/**
 * Waits until this PR's Coolify preview serves the PR's head commit, then prints its URL (for Playwright).
 * Coolify builds every PR at https://pr<N>-<app>.vinothkannan.de; each build publishes the commit it was
 * built from at /werft-commit.txt (see Dockerfile), so an older preview is never mistaken for this one.
 * env: PR_NUMBER, GIT_COMMIT_SHA, APP_NAME (the repo name), optional PREVIEW_DOMAIN, TIMEOUT_MINUTES.
 */
const { PR_NUMBER, GIT_COMMIT_SHA, APP_NAME } = process.env
for (const [k, v] of Object.entries({ PR_NUMBER, GIT_COMMIT_SHA, APP_NAME })) if (!v) { console.error(`missing env ${k}`); process.exit(1) }
const url = `https://pr${PR_NUMBER}-${APP_NAME}.${process.env.PREVIEW_DOMAIN ?? 'vinothkannan.de'}`
const deadline = Date.now() + Number(process.env.TIMEOUT_MINUTES ?? 25) * 60_000
let last = ''
while (Date.now() < deadline) {
  try {
    const r = await fetch(`${url}/werft-commit.txt`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) })
    const body = r.ok ? (await r.text()).trim() : `HTTP ${r.status}`
    if (body === GIT_COMMIT_SHA) {
      const home = await fetch(url, { signal: AbortSignal.timeout(30_000) })
      if (home.status < 500) { console.log(url); process.exit(0) }
      last = `commit is live but / answered ${home.status}`
    } else last = body.length === 40 ? `serving ${body.slice(0, 7)}, waiting for ${GIT_COMMIT_SHA.slice(0, 7)}` : body
  } catch (e) { last = String(e.message ?? e) }
  console.error(`${new Date().toISOString().slice(11, 19)} ${url}: ${last}`)
  await new Promise((r) => setTimeout(r, 15_000))
}
console.error(`timed out waiting for ${url} to serve ${GIT_COMMIT_SHA}`); process.exit(1)
