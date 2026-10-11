import { afterEach, describe, expect, it, vi } from "vitest"
import {
  appsDbDeleteCommand,
  createAppDatabase,
  databaseName,
  deleteAppDatabase,
  parseAdminUrl,
  verifyAppsDb,
} from "./appsdb.ts"
import * as execModule from "./exec.ts"

const ADMIN = "postgresql://postgres:s3cret@apps-db:5432/postgres"

afterEach(() => {
  vi.restoreAllMocks()
})

/** Answers psql calls in order; records argv, stdin and env of each. */
function fakePsql(replies: { code: number; stdout?: string; stderr?: string }[]) {
  const calls: { args: readonly string[]; input?: string; env?: Record<string, string> }[] = []
  vi.spyOn(execModule, "exec").mockImplementation(async (_cmd, args, options = {}) => {
    calls.push({ args, input: options.input, env: options.env })
    const reply = replies.shift() ?? { code: 0 }
    return { code: reply.code, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" }
  })
  return calls
}

describe("databaseName", () => {
  it("turns hyphens into underscores, since app names allow hyphens and identifiers should not need quoting", () => {
    expect(databaseName("trip-friend")).toBe("trip_friend")
  })
})

describe("parseAdminUrl", () => {
  it("reads a postgres URL", () => {
    expect(parseAdminUrl(ADMIN)).toEqual({
      host: "apps-db",
      port: "5432",
      user: "postgres",
      password: "s3cret",
      database: "postgres",
    })
  })
  it("rejects anything that is not one", () => {
    expect(parseAdminUrl("https://example.com")).toBeNull()
    expect(parseAdminUrl("not a url")).toBeNull()
  })
})

describe("verifyAppsDb", () => {
  it("is ok when psql answers", async () => {
    fakePsql([{ code: 0, stdout: "1" }])
    expect(await verifyAppsDb(ADMIN)).toBe("ok")
  })
  it("tells a bad password from an unreachable server", async () => {
    fakePsql([{ code: 2, stderr: 'FATAL:  password authentication failed for user "postgres"' }])
    expect(await verifyAppsDb(ADMIN)).toBe("rejected")
    fakePsql([{ code: 2, stderr: "could not translate host name" }])
    expect(await verifyAppsDb(ADMIN)).toBe("unreachable")
  })
})

describe("createAppDatabase", () => {
  it("creates the role and both databases, and the preview URL ends in _preview", async () => {
    const calls = fakePsql([{ code: 0, stdout: "0\n0" }, { code: 0 }])
    const db = await createAppDatabase("trip-friend", ADMIN)
    expect(db.database).toBe("trip_friend")
    expect(new URL(db.connectionUri).pathname).toBe("/trip_friend")
    expect(new URL(db.previewUri).pathname).toBe("/trip_friend_preview")
    expect(calls[1]?.input).toContain('create database "trip_friend_preview" owner "trip_friend"')
  })

  it("keeps the admin password out of argv", async () => {
    const calls = fakePsql([{ code: 0, stdout: "0\n0" }, { code: 0 }])
    await createAppDatabase("trip-friend", ADMIN)
    for (const call of calls) {
      expect(call.args.join(" ")).not.toContain("s3cret")
      expect(call.env?.PGPASSWORD).toBe("s3cret")
    }
  })

  it("refuses to adopt a database or role that already exists", async () => {
    const calls = fakePsql([{ code: 0, stdout: "1\n0" }])
    await expect(createAppDatabase("trip-friend", ADMIN)).rejects.toThrow(/refusing to adopt/)
    expect(calls).toHaveLength(1)
  })
})

describe("deleteAppDatabase", () => {
  it("reports absent when there is nothing to drop", async () => {
    fakePsql([{ code: 0, stdout: "0\n0" }])
    expect(await deleteAppDatabase("gone", ADMIN)).toBe("absent")
  })
  it("ends open sessions, then drops both databases and the role", async () => {
    const calls = fakePsql([{ code: 0, stdout: "2\n1" }, { code: 0 }])
    expect(await deleteAppDatabase("trip-friend", ADMIN)).toBe("removed")
    const sql = calls[1]?.input ?? ""
    expect(sql.indexOf("pg_terminate_backend")).toBeLessThan(sql.indexOf("drop database"))
    expect(sql).toContain('drop role if exists "trip_friend"')
  })
})

describe("appsDbDeleteCommand", () => {
  it("names both databases and the role", () => {
    const cmd = appsDbDeleteCommand("trip-friend")
    expect(cmd).toContain("trip_friend_preview")
    expect(cmd).toContain('drop role if exists "trip_friend"')
  })
})
