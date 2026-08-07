/**
 * A record of everything created, so a failure never leaves silent half-state.
 *
 * Each entry carries an exact cleanup command whether or not it can be undone
 * automatically. Automatic rollback is best-effort — the gh token, for one,
 * usually lacks the delete_repo scope — and anything left standing gets printed
 * as a command to paste.
 */

export type Resource = {
  /** Human description, e.g. "GitHub repository vinoth4v/foo". */
  what: string
  /** Exact command that removes it. Printed when automatic rollback cannot. */
  cleanup: string
  /** Best-effort automatic removal. Resolves true only if it definitely worked. */
  undo?: () => Promise<boolean>
}

export class Ledger {
  private readonly created: Resource[] = []

  record(resource: Resource): void {
    this.created.push(resource)
  }

  entries(): readonly Resource[] {
    return this.created
  }

  get size(): number {
    return this.created.length
  }

  /**
   * Undoes in reverse order of creation and returns whatever is still standing.
   *
   * Reverse order matters: the local directory holds the Vercel link, so it
   * must go last.
   */
  async rollback(onAttempt?: (resource: Resource, undone: boolean) => void): Promise<Resource[]> {
    const orphaned: Resource[] = []

    for (const resource of [...this.created].reverse()) {
      let undone = false
      if (resource.undo) {
        try {
          undone = await resource.undo()
        } catch {
          undone = false
        }
      }

      onAttempt?.(resource, undone)
      if (!undone) orphaned.push(resource)
    }

    return orphaned
  }
}
