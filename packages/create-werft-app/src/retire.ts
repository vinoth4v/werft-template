import { deleteAppAwsUser } from "./iam.ts"
import { deleteNeonProject, findNeonProjectId } from "./neon.ts"
import {
  bucketRegion,
  deleteBucket,
  emptyBucket,
  listAppBuckets,
  resolveAwsCredentials,
} from "./s3.ts"
import { deleteVercelProject, resolveVercelToken } from "./vercel.ts"

/**
 * Retires an app: removes every remote resource the scaffold created for it.
 *
 * The inverse of create-werft-app, and deliberately shaped differently. The
 * scaffold works cheapest-to-undo first so a failure leaves little behind.
 * Retirement cannot be undone at all, so it works in the opposite direction:
 * the infrastructure goes first and the repository last, because the repository
 * is the only part holding anything irreplaceable. If a step fails halfway, the
 * code still exists and the app can be reached to try again.
 *
 * Every step reports what actually happened — "removed", "absent", or "failed"
 * with the reason. Nothing reports success it did not verify: a retirement that
 * claims to be complete while a database quietly survives is worse than one
 * that admits it stopped, because the resource keeps costing money nobody is
 * looking for.
 */

export type StepOutcome = "removed" | "absent" | "failed" | "skipped"

export type RetireStep = {
  what: string
  outcome: StepOutcome
  detail?: string
}

export type RetireResult = {
  name: string
  steps: RetireStep[]
  /** True only when nothing failed. Absent and skipped are both fine. */
  complete: boolean
  /** What a human still has to do, when anything did not come away cleanly. */
  leftovers: string[]
}

export type RetireOptions = {
  name: string
  /** The repository, and the code in it, are only removed when asked. */
  deleteRepo: boolean
  dryRun: boolean
  /** Injected so the workflow can pass a GitHub CLI runner; kept out of here
   * so this module has no opinion about how commands are run. */
  runGh?: (args: readonly string[]) => Promise<{ code: number; stderr: string }>
  registryBaseUrl?: string
}

const DEFAULT_REGISTRY = "https://werft-marketplace.vercel.app"

export async function retire(
  options: RetireOptions,
  log: (line: string) => void,
): Promise<RetireResult> {
  const steps: RetireStep[] = []
  const { name, dryRun } = options

  const record = (step: RetireStep): void => {
    steps.push(step)
    const mark =
      step.outcome === "removed"
        ? "removed"
        : step.outcome === "absent"
          ? "already gone"
          : step.outcome === "skipped"
            ? "skipped"
            : "FAILED"
    log(`  ${step.what}: ${mark}${step.detail ? ` — ${step.detail}` : ""}`)
  }

  const announce = (what: string): void => {
    if (dryRun) log(`  [dry-run] would remove ${what}`)
  }

  // ---- 1. Vercel ---------------------------------------------------------
  // First because it is what serves the app: once it is gone the app is off
  // the internet, which is the point of retiring it.
  announce(`Vercel project ${name}`)
  if (!dryRun) {
    const auth = await resolveVercelToken()
    if (!auth) {
      record({
        what: `Vercel project ${name}`,
        outcome: "failed",
        detail: "no Vercel API token (run `vercel login` or set VERCEL_TOKEN)",
      })
    } else {
      const gone = await deleteVercelProject(name, auth.token)
      record({
        what: `Vercel project ${name}`,
        outcome: gone ? "removed" : "failed",
        detail: gone ? undefined : "Vercel refused the delete",
      })
    }
  }

  // ---- 2. Neon -----------------------------------------------------------
  announce(`Neon project ${name}`)
  if (!dryRun) {
    const apiKey = process.env.NEON_API_KEY ?? ""
    if (apiKey === "") {
      record({ what: `Neon project ${name}`, outcome: "failed", detail: "NEON_API_KEY is not set" })
    } else {
      const id = await findNeonProjectId(name, apiKey)
      if (id === "") {
        record({ what: `Neon project ${name}`, outcome: "absent" })
      } else {
        const gone = await deleteNeonProject(id, apiKey)
        record({
          what: `Neon project ${name} (${id})`,
          outcome: gone ? "removed" : "failed",
          detail: gone ? undefined : "Neon refused the delete",
        })
      }
    }
  }

  // ---- 3. S3 buckets and the app's scoped AWS user -----------------------
  // Found by naming convention rather than remembered: see listAppBuckets.
  // Absent credentials are "skipped", not "failed" — an app scaffolded without
  // --with-s3 has nothing here, and demanding AWS keys to retire it would be
  // wrong.
  announce(`S3 buckets for ${name}, and IAM user werft-${name}`)
  if (!dryRun) {
    const creds = await resolveAwsCredentials()
    if (!creds) {
      record({
        what: "S3 and IAM",
        outcome: "skipped",
        detail: "no AWS credentials — nothing checked; if this app had a bucket, remove it by hand",
      })
    } else {
      const buckets = await listAppBuckets(name, creds)
      if (buckets.length === 0) {
        record({ what: `S3 buckets for ${name}`, outcome: "absent" })
      }
      for (const bucket of buckets) {
        const region = await bucketRegion(bucket, creds)
        if (region === "") {
          record({
            what: `S3 bucket ${bucket}`,
            outcome: "failed",
            detail: "could not determine its region",
          })
          continue
        }
        // A bucket holding objects cannot be deleted, so emptying is part of
        // deleting rather than a separate courtesy.
        const emptied = await emptyBucket(bucket, region, creds)
        if (!emptied.drained) {
          record({
            what: `S3 bucket ${bucket}`,
            outcome: "failed",
            detail: `could not empty it (${emptied.deleted} objects deleted); bucket left in place`,
          })
          continue
        }
        const gone = await deleteBucket(bucket, region, creds)
        record({
          what: `S3 bucket ${bucket}`,
          outcome: gone ? "removed" : "failed",
          detail: gone
            ? emptied.deleted > 0
              ? `${emptied.deleted} objects deleted first`
              : undefined
            : "S3 refused the delete",
        })
      }

      const userName = `werft-${name}`
      const userGone = await deleteAppAwsUser(userName, "", creds)
      record({
        what: `IAM user ${userName}`,
        outcome: userGone ? "removed" : "failed",
        detail: userGone ? undefined : "IAM refused the delete — check for attached policies",
      })
    }
  }

  // ---- 4. the registry row ----------------------------------------------
  // Before the repository, so the app stops appearing on the wall even if the
  // repository delete is refused.
  announce(`registry row ${name}`)
  if (!dryRun) {
    const token = process.env.WERFT_REGISTRY_TOKEN ?? ""
    if (token === "") {
      record({
        what: `registry row ${name}`,
        outcome: "failed",
        detail: "WERFT_REGISTRY_TOKEN is not set",
      })
    } else {
      const base = options.registryBaseUrl ?? DEFAULT_REGISTRY
      const response = await fetch(`${base}/api/registry/apps/${name}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => null)
      if (response?.ok) {
        record({ what: `registry row ${name}`, outcome: "removed" })
      } else if (response?.status === 404) {
        record({ what: `registry row ${name}`, outcome: "absent" })
      } else {
        record({
          what: `registry row ${name}`,
          outcome: "failed",
          detail: response ? `registry answered ${response.status}` : "registry unreachable",
        })
      }
    }
  }

  // ---- 5. the GitHub repository, last -----------------------------------
  // The code is the only irreplaceable thing here, so it is removed last and
  // only on request. Everything above can be rebuilt from it.
  if (!options.deleteRepo) {
    record({
      what: "GitHub repository",
      outcome: "skipped",
      detail: "kept — the code is still there",
    })
  } else {
    announce(`GitHub repository ${name}`)
    if (!dryRun) {
      const runGh = options.runGh
      if (!runGh) {
        record({
          what: `GitHub repository ${name}`,
          outcome: "failed",
          detail: "no gh runner supplied",
        })
      } else {
        const result = await runGh(["repo", "delete", name, "--yes"])
        const alreadyGone = /not found|could not resolve/i.test(result.stderr)
        record({
          what: `GitHub repository ${name}`,
          outcome: result.code === 0 ? "removed" : alreadyGone ? "absent" : "failed",
          detail:
            result.code === 0 || alreadyGone
              ? undefined
              : result.stderr.split("\n")[0] ||
                "gh refused — the token may lack the delete_repo scope",
        })
      }
    }
  }

  const failures = steps.filter((step) => step.outcome === "failed")
  return {
    name,
    steps,
    complete: failures.length === 0,
    leftovers: failures.map((step) => `${step.what}: ${step.detail ?? "failed"}`),
  }
}
