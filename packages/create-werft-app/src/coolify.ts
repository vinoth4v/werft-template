/**
 * The app's deployment on Coolify (home server), replacing the Vercel project.
 *
 * Coolify builds the repository's Dockerfile on every push to main and gives
 * every pull request a preview at pr<N>-<app>.<domain>. Its API is reachable
 * only inside the home network (the self-hosted runner): COOLIFY_API_URL, e.g.
 * http://coolify:8080/api/v1, and COOLIFY_API_TOKEN. Plain fetch, no SDK.
 *
 * The settings mirror homestack's coolify_migrate.py, which moved the existing
 * fleet: domains are plain http://<app>.<domain> because Cloudflare terminates
 * TLS in front; Coolify's own health check is off because the image declares
 * its own (slim images have no curl/wget for Coolify's); the source commit is
 * passed to the build so a preview can publish which commit it serves.
 */

export type CoolifyAuth = { base: string; token: string }

export type CoolifyCheck = "ok" | "rejected" | "unreachable"

export const DEFAULT_DOMAIN = "vinothkannan.de"

export function coolifyFromEnv(env: NodeJS.ProcessEnv = process.env): CoolifyAuth | null {
  const base = (env.COOLIFY_API_URL ?? "").replace(/\/+$/, "")
  const token = env.COOLIFY_API_TOKEN ?? ""
  return base && token ? { base, token } : null
}

export function appDomain(name: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${name}.${env.WERFT_DOMAIN || DEFAULT_DOMAIN}`
}

class CoolifyError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function call<T>(
  auth: CoolifyAuth,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${auth.base}/${path.replace(/^\//, "")}`, {
      method,
      headers: {
        Authorization: `Bearer ${auth.token}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (error) {
    throw new CoolifyError(
      `Coolify unreachable: ${error instanceof Error ? error.message : String(error)}`,
      0,
    )
  }
  const text = await response.text()
  if (!response.ok) {
    let detail = text.slice(0, 300)
    try {
      const parsed = JSON.parse(text) as { message?: unknown }
      if (typeof parsed.message === "string") detail = parsed.message
    } catch {
      // keep the raw text
    }
    throw new CoolifyError(
      `Coolify ${method} ${path} -> ${response.status}: ${detail}`,
      response.status,
    )
  }
  // Most endpoints answer JSON; a few (GET /version) answer plain text.
  if (text === "") return {} as T
  try {
    return JSON.parse(text) as T
  } catch {
    return text as T
  }
}

/** Whether the API answers this token — for the scaffold's preflight. */
export async function verifyCoolify(auth: CoolifyAuth): Promise<CoolifyCheck> {
  try {
    await call(auth, "GET", "version")
    return "ok"
  } catch (error) {
    const status = error instanceof CoolifyError ? error.status : 0
    return status === 401 || status === 403 ? "rejected" : "unreachable"
  }
}

type Ids = {
  server_uuid: string
  project_uuid: string
  environment_uuid: string
  environment_name: string
  github_app_uuid: string
}

/** The Coolify host server, the "Apps" project's production environment, and the GitHub App. */
async function placement(auth: CoolifyAuth): Promise<Ids> {
  const servers = await call<{ uuid: string; is_coolify_host?: boolean }[]>(auth, "GET", "servers")
  const server = servers.find((s) => s.is_coolify_host) ?? servers[0]
  if (!server) throw new Error("Coolify has no server to deploy to")
  const apps = await call<{ uuid: string; app_id?: unknown }[]>(auth, "GET", "github-apps")
  const github = apps.find((g) => g.app_id)
  if (!github) throw new Error("Coolify has no GitHub App connected (Sources -> GitHub App)")
  const projects = await call<{ uuid: string; name: string }[]>(auth, "GET", "projects")
  const project =
    projects.find((p) => p.name === "Apps") ??
    (await call<{ uuid: string }>(auth, "POST", "projects", {
      name: "Apps",
      description: "Werft apps",
    }))
  const full = await call<{ environments: { uuid: string; name: string }[] }>(
    auth,
    "GET",
    `projects/${project.uuid}`,
  )
  const env = full.environments.find((e) => e.name === "production")
  if (!env) throw new Error("the Coolify project has no production environment")
  return {
    server_uuid: server.uuid,
    project_uuid: project.uuid,
    environment_uuid: env.uuid,
    environment_name: env.name,
    github_app_uuid: github.uuid,
  }
}

/** The uuid of the Coolify application called `name`, or "" when there is none. */
export async function findCoolifyApp(auth: CoolifyAuth, name: string): Promise<string> {
  const apps = await call<{ uuid: string; name: string }[]>(auth, "GET", "applications")
  return apps.find((a) => a.name === name)?.uuid ?? ""
}

/**
 * Creates the application from `owner/name` on GitHub, without deploying it.
 * A 404 here almost always means Coolify's GitHub App cannot see the new
 * repository: its installation must cover all repositories (GitHub ->
 * Settings -> Applications -> Coolify -> Configure).
 */
export async function createCoolifyApp(
  auth: CoolifyAuth,
  options: { name: string; repository: string; domain: string },
): Promise<string> {
  if (await findCoolifyApp(auth, options.name)) {
    throw new Error(
      `a Coolify application named ${options.name} already exists — refusing to adopt it`,
    )
  }
  const ids = await placement(auth)
  try {
    const created = await call<{ uuid: string }>(auth, "POST", "applications/private-github-app", {
      ...ids,
      name: options.name,
      git_repository: options.repository,
      git_branch: "main",
      build_pack: "dockerfile",
      ports_exposes: "3000",
      domains: `http://${options.domain}`,
      is_force_https_enabled: false,
      is_auto_deploy_enabled: true,
      is_preview_deployments_enabled: true,
      preview_url_template: "pr{{pr_id}}-{{domain}}",
      include_source_commit_in_build: true,
      health_check_enabled: false,
      instant_deploy: false,
      limits_memory: "1g",
      limits_cpus: "1.5",
    })
    return created.uuid
  } catch (error) {
    if (error instanceof CoolifyError && error.status === 404) {
      throw new Error(
        `Coolify cannot see ${options.repository}: give its GitHub App access to all repositories (GitHub -> Settings -> Applications -> Coolify -> Configure), then retry`,
      )
    }
    throw error
  }
}

/**
 * Sets one variable, production or preview, leaving exactly one entry.
 * Values are literal: a password hash full of `$` must arrive as written.
 */
export async function setCoolifyEnv(
  auth: CoolifyAuth,
  uuid: string,
  key: string,
  value: string,
  options: { preview?: boolean } = {},
): Promise<void> {
  const body = {
    key,
    value,
    is_preview: options.preview ?? false,
    is_literal: true,
    is_multiline: value.includes("\n"),
  }
  try {
    await call(auth, "POST", `applications/${uuid}/envs`, body)
  } catch (error) {
    if (error instanceof CoolifyError && error.status === 409) {
      await call(auth, "PATCH", `applications/${uuid}/envs`, body)
      return
    }
    throw error
  }
}

/** Starts a deployment of main and returns its id. */
export async function deployCoolifyApp(auth: CoolifyAuth, uuid: string): Promise<string> {
  const started = await call<{ deployments?: { deployment_uuid?: string }[] }>(
    auth,
    "POST",
    `deploy?uuid=${uuid}`,
  )
  const id = started.deployments?.[0]?.deployment_uuid
  if (!id) throw new Error("Coolify accepted the deploy but returned no deployment id")
  return id
}

/** Waits for a deployment to finish; resolves to its final status. */
export async function waitForDeployment(
  auth: CoolifyAuth,
  deploymentId: string,
  timeoutMs = 25 * 60_000,
  pollMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const deployment = await call<{ status?: string }>(auth, "GET", `deployments/${deploymentId}`)
    const status = deployment.status ?? ""
    if (["finished", "failed", "cancelled-by-user"].includes(status)) return status
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  return "timed out"
}

/** Deletes the application with its containers and volumes; "absent" when there was none. */
export async function deleteCoolifyApp(
  auth: CoolifyAuth,
  name: string,
): Promise<"removed" | "absent"> {
  const uuid = await findCoolifyApp(auth, name)
  if (!uuid) return "absent"
  await call(
    auth,
    "DELETE",
    `applications/${uuid}?delete_configurations=true&delete_volumes=true&docker_cleanup=true&delete_connected_networks=true`,
  )
  return "removed"
}

export function coolifyDeleteCommand(name: string): string {
  return `delete the application "${name}" in Coolify (https://coolify.${DEFAULT_DOMAIN} -> Projects -> Apps -> ${name} -> Danger zone)`
}
