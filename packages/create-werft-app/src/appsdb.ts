import { randomBytes } from "node:crypto"
import { exec } from "./exec.ts"

/**
 * An app's database on the home server's shared Postgres (apps-db): one login
 * role, one production database and one `_preview` database, both owned by
 * that role. Replaces the Neon project the scaffold used to create.
 *
 * Plain `psql`, no driver dependency — the same rule as the rest of this
 * package. Reached only from inside the home network (the self-hosted runner),
 * with the admin connection string in APPS_DB_ADMIN_URL. Credentials travel as
 * PG* environment variables and SQL on stdin, never in argv: argv is visible in
 * process listings.
 *
 * Why a `_preview` database at all: every PR preview of the app runs against
 * it (Coolify hands previews their own settings), so a preview can never touch
 * production data. homestack's preview-db-refresh.sh copies production into it
 * nightly; the preview container migrates it itself when it starts.
 */

export type AppDatabase = {
  database: string
  role: string
  /** For the app's production environment. */
  connectionUri: string
  /** For PR previews; always ends in `_preview` (deploy/start.mjs checks). */
  previewUri: string
}

export type AppsDbCheck = "ok" | "rejected" | "unreachable"

/** Postgres identifiers for an app name: hyphens become underscores. */
export function databaseName(appName: string): string {
  return appName.replace(/-/g, "_")
}

type Admin = { host: string; port: string; user: string; password: string; database: string }

export function parseAdminUrl(url: string): Admin | null {
  try {
    const u = new URL(url)
    if (!/^postgres(ql)?:$/.test(u.protocol) || u.hostname === "" || u.username === "") return null
    return {
      host: u.hostname,
      port: u.port || "5432",
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, "") || "postgres",
    }
  } catch {
    return null
  }
}

async function psql(
  admin: Admin,
  sql: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return exec("psql", ["-v", "ON_ERROR_STOP=1", "-Atq"], {
    input: sql,
    env: {
      PGHOST: admin.host,
      PGPORT: admin.port,
      PGUSER: admin.user,
      PGPASSWORD: admin.password,
      PGDATABASE: admin.database,
      PGCONNECT_TIMEOUT: "10",
    },
  })
}

/** Whether the admin connection works — for the scaffold's preflight. */
export async function verifyAppsDb(adminUrl: string): Promise<AppsDbCheck> {
  const admin = parseAdminUrl(adminUrl)
  if (!admin) return "rejected"
  const result = await psql(admin, "select 1;")
  if (result.code === 0) return "ok"
  return /password authentication failed|role .* does not exist/i.test(result.stderr)
    ? "rejected"
    : "unreachable"
}

/**
 * Creates the role and both databases. Fails, rather than reusing anything, if
 * any of them already exists: an existing database under this name belongs to
 * some other app, and adopting it would be far worse than stopping.
 */
export async function createAppDatabase(appName: string, adminUrl: string): Promise<AppDatabase> {
  const admin = parseAdminUrl(adminUrl)
  if (!admin) throw new Error("APPS_DB_ADMIN_URL is not a postgres:// connection string")
  const name = databaseName(appName)
  const preview = `${name}_preview`
  const password = randomBytes(24).toString("hex")

  const exists = await psql(
    admin,
    `select count(*) from pg_database where datname in ('${name}', '${preview}');\n` +
      `select count(*) from pg_roles where rolname = '${name}';`,
  )
  if (exists.code !== 0) throw new Error(`apps-db refused the check: ${firstLine(exists.stderr)}`)
  if (exists.stdout.split("\n").some((n) => n.trim() !== "0")) {
    throw new Error(
      `a database or role named ${name} already exists on apps-db — refusing to adopt it`,
    )
  }

  // CREATE DATABASE cannot run inside a transaction block, so these are
  // separate statements; on failure the caller's ledger drops whatever exists.
  const created = await psql(
    admin,
    `create role "${name}" login password '${password}';\n` +
      `create database "${name}" owner "${name}";\n` +
      `create database "${preview}" owner "${name}";\n`,
  )
  if (created.code !== 0) {
    throw new Error(`apps-db refused to create the database: ${firstLine(created.stderr)}`)
  }

  const uri = (db: string) =>
    `postgresql://${name}:${password}@${process.env.APPS_DB_HOST ?? admin.host}:${admin.port}/${db}?sslmode=disable`
  return { database: name, role: name, connectionUri: uri(name), previewUri: uri(preview) }
}

/**
 * Drops both databases and the role. "absent" when there was nothing to drop.
 * Open sessions are ended first: a database with a connected client cannot be
 * dropped, and the app being retired may still have one.
 */
export async function deleteAppDatabase(
  appName: string,
  adminUrl: string,
): Promise<"removed" | "absent" | "failed"> {
  const admin = parseAdminUrl(adminUrl)
  if (!admin) return "failed"
  const name = databaseName(appName)
  const preview = `${name}_preview`

  const found = await psql(
    admin,
    `select count(*) from pg_database where datname in ('${name}', '${preview}');\n` +
      `select count(*) from pg_roles where rolname = '${name}';`,
  )
  if (found.code !== 0) return "failed"
  if (found.stdout.split("\n").every((n) => n.trim() === "0")) return "absent"

  const dropped = await psql(
    admin,
    `select pg_terminate_backend(pid) from pg_stat_activity where datname in ('${name}', '${preview}');\n` +
      `drop database if exists "${preview}";\n` +
      `drop database if exists "${name}";\n` +
      `drop role if exists "${name}";\n`,
  )
  return dropped.code === 0 ? "removed" : "failed"
}

/** The exact command that removes what createAppDatabase made, for the ledger. */
export function appsDbDeleteCommand(appName: string): string {
  const name = databaseName(appName)
  return `docker exec apps-db psql -U postgres -c 'drop database if exists "${name}_preview"' -c 'drop database if exists "${name}"' -c 'drop role if exists "${name}"'`
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? ""
}
