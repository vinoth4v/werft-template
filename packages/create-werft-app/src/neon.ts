/**
 * The slice of the Neon API this needs: create a project, delete a project.
 *
 * Uses global fetch rather than a client library — two endpoints do not justify
 * a dependency.
 *
 * The API key comes from NEON_API_KEY and is never written to disk, never
 * passed as a command-line argument (where it would land in shell history and
 * process listings), and never included in a printed cleanup command.
 */

const NEON_API = "https://console.neon.tech/api/v2"

export type NeonProject = {
  id: string
  connectionUri: string
}

export type NeonKeyCheck = "ok" | "rejected" | "unreachable"

/**
 * Verifies the API key before anything is created.
 *
 * Checking that NEON_API_KEY is merely set is not enough — a stale key, or a
 * placeholder someone exported verbatim, would pass that test and then fail at
 * project creation, by which point a GitHub repository already exists. Ordering
 * steps cheapest-to-undo first only helps if credentials are proven first.
 *
 * A GET creates nothing, so this is safe to run during a dry run too.
 *
 * Verifies against /projects, the same collection the scaffold posts to, and
 * not /users/me: that route 404s on at least some Neon plans, and since Neon
 * authenticates before it routes, a valid key there looks indistinguishable
 * from a broken API. Verifying against the endpoint actually used avoids
 * refusing to run on a good credential.
 */
export async function verifyNeonApiKey(apiKey: string): Promise<NeonKeyCheck> {
  let response: Response
  try {
    response = await fetch(`${NEON_API}/projects`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
  } catch {
    return "unreachable"
  }

  if (response.ok) return "ok"
  // Anything else — 500s, rate limits — is not evidence the key is wrong.
  return response.status === 401 || response.status === 403 ? "rejected" : "unreachable"
}

export async function createNeonProject(name: string, apiKey: string): Promise<NeonProject> {
  const response = await fetch(`${NEON_API}/projects`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ project: { name } }),
  })

  const body = (await response.json().catch(() => null)) as {
    project?: { id?: unknown }
    connection_uris?: { connection_uri?: unknown }[]
    message?: unknown
  } | null

  if (!response.ok) {
    const detail = typeof body?.message === "string" ? body.message : response.statusText
    throw new Error(`Neon refused to create the project (${response.status}): ${detail}`)
  }

  const id = body?.project?.id
  const connectionUri = body?.connection_uris?.[0]?.connection_uri

  if (typeof id !== "string" || typeof connectionUri !== "string") {
    throw new Error("Neon accepted the request but returned no project id or connection string")
  }

  return { id, connectionUri }
}

export async function deleteNeonProject(id: string, apiKey: string): Promise<boolean> {
  const response = await fetch(`${NEON_API}/projects/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey}` },
  })

  return response.ok
}

/** Cleanup command for an orphaned project. Reads the key from the environment. */
export function neonDeleteCommand(id: string): string {
  return `curl -fsS -X DELETE -H "Authorization: Bearer $NEON_API_KEY" ${NEON_API}/projects/${id}`
}
