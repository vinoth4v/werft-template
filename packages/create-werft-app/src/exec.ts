import { spawn } from "node:child_process"

export type ExecResult = {
  code: number
  stdout: string
  stderr: string
}

export type ExecOptions = {
  cwd?: string
  env?: Record<string, string>
  /** Inherit stdio instead of capturing, for commands with long live output. */
  stream?: boolean
  /** Written to stdin and closed — how `vercel env add` takes a value. */
  input?: string
}

export async function exec(
  command: string,
  args: readonly string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: options.stream
        ? [options.input === undefined ? "ignore" : "pipe", "inherit", "inherit"]
        : [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on("error", (error) => {
      resolve({ code: 127, stdout, stderr: error.message })
    })
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() })
    })

    if (options.input !== undefined && child.stdin) {
      child.stdin.end(options.input)
    }
  })
}

const SAFE_ARGUMENT = /^[\w@%+=:,./-]+$/

/** Renders a command the way it would be typed, for logs and cleanup hints. */
export function quote(command: string, args: readonly string[]): string {
  return [command, ...args]
    .map((part) => (SAFE_ARGUMENT.test(part) ? part : `'${part.replaceAll("'", `'\\''`)}'`))
    .join(" ")
}
