import { describe, expect, it } from "vitest"
import { Ledger } from "./ledger.ts"

describe("Ledger", () => {
  it("rolls back in reverse order of creation", async () => {
    const undone: string[] = []
    const ledger = new Ledger()

    for (const what of ["first", "second", "third"]) {
      ledger.record({
        what,
        cleanup: `remove ${what}`,
        undo: async () => {
          undone.push(what)
          return true
        },
      })
    }

    expect(await ledger.rollback()).toEqual([])
    expect(undone).toEqual(["third", "second", "first"])
  })

  it("reports whatever it could not remove", async () => {
    const ledger = new Ledger()
    ledger.record({ what: "removable", cleanup: "rm removable", undo: async () => true })
    ledger.record({ what: "stubborn", cleanup: "rm stubborn", undo: async () => false })

    const orphaned = await ledger.rollback()

    expect(orphaned.map((resource) => resource.what)).toEqual(["stubborn"])
    expect(orphaned[0]?.cleanup).toBe("rm stubborn")
  })

  it("treats a resource with no undo as orphaned, not as removed", async () => {
    const ledger = new Ledger()
    ledger.record({ what: "manual only", cleanup: "do it yourself" })

    expect(await ledger.rollback()).toHaveLength(1)
  })

  it("keeps going when an undo throws", async () => {
    const ledger = new Ledger()
    ledger.record({ what: "later", cleanup: "rm later", undo: async () => true })
    ledger.record({
      what: "explodes",
      cleanup: "rm explodes",
      undo: async () => {
        throw new Error("network gone")
      },
    })

    const orphaned = await ledger.rollback()

    // The thrower is reported, and the one created before it still got removed.
    expect(orphaned.map((resource) => resource.what)).toEqual(["explodes"])
  })

  it("reports every attempt to the callback", async () => {
    const seen: [string, boolean][] = []
    const ledger = new Ledger()
    ledger.record({ what: "a", cleanup: "rm a", undo: async () => true })
    ledger.record({ what: "b", cleanup: "rm b" })

    await ledger.rollback((resource, wasUndone) => seen.push([resource.what, wasUndone]))

    expect(seen).toEqual([
      ["b", false],
      ["a", true],
    ])
  })

  it("has nothing to roll back before anything is recorded", async () => {
    const ledger = new Ledger()
    expect(ledger.size).toBe(0)
    expect(await ledger.rollback()).toEqual([])
  })
})
