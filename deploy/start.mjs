// Container start for self-hosting (Coolify): migrate this container's own database, then start Next.js.
// Production containers migrate production; PR previews (pr<N>-<app>.vinothkannan.de) migrate <db>_preview.
// A preview refuses to start unless its database name ends in _preview, so a preview can never touch production.
// A failed migration exits non-zero: the new container never becomes healthy and Coolify keeps the old one serving.
import { spawnSync } from 'node:child_process'

const url = process.env.DATABASE_URL
const host = (process.env.COOLIFY_FQDN || process.env.COOLIFY_URL || '').replace(/^https?:\/\//, '')
const preview = /^pr\d+-/.test(host) || process.env.IS_PREVIEW === 'true'
if (!url) { console.error('start: DATABASE_URL is not set'); process.exit(1) }
const db = new URL(url).pathname.replace(/^\//, '')
if (preview && !db.endsWith('_preview')) {
  console.error(`start: preview deployment (${host}) but DATABASE_URL points at "${db}", not a _preview database — refusing to start`)
  process.exit(1)
}
// Coolify falls back to the production AUTH_URL when a preview has none of its own; sign-in must stay on the preview's host.
const env = { ...process.env }
if (preview && process.env.COOLIFY_FQDN) env.AUTH_URL = env.NEXTAUTH_URL = `https://${process.env.COOLIFY_FQDN}`
console.log(`start: applying migrations to ${db} (${preview ? 'preview' : 'production'})`)
// what `pnpm run db:migrate` runs (pnpm itself is only in the build stage of the image)
const m = spawnSync('node', ['--experimental-strip-types', 'scripts/migrate.ts'], { stdio: 'inherit', cwd: '/app/apps/web', env })
if (m.status !== 0) { console.error(`start: migration failed (exit ${m.status ?? m.error?.message}); not starting`); process.exit(m.status ?? 1) }
const s = spawnSync('node', ['node_modules/next/dist/bin/next', 'start', '-p', '3000', '-H', '0.0.0.0'], { stdio: 'inherit', cwd: '/app/apps/web', env })
process.exit(s.status ?? 1)
