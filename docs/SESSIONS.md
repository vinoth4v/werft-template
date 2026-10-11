# Sessions

## 2026-10-11 — Off Vercel and Neon: Coolify on the home server

Production deploys from the Dockerfile on every push to `main`; PRs get a Coolify
preview at `pr<N>-werft-template.vinothkannan.de` on a nightly copy of the production
database. The container migrates its own database before starting
(`deploy/start.mjs`); `proxy.ts` lets `/werft-commit.txt` through so CI can tell
the preview serves the PR's commit before Playwright runs.
