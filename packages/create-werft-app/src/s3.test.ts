import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createBucket, resolveAwsCredentials } from "./s3.ts"

afterEach(() => vi.unstubAllGlobals())

describe("resolveAwsCredentials", () => {
  it("reads the [default] profile from a credentials file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "werft-aws-"))
    const path = join(dir, "credentials")
    await writeFile(
      path,
      "[default]\naws_access_key_id = AKIAEXAMPLE\naws_secret_access_key = secretexample\n",
    )
    expect(await resolveAwsCredentials(path)).toEqual({
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "secretexample",
    })
  })

  it("returns null when neither env nor file has credentials", async () => {
    expect(await resolveAwsCredentials(join(tmpdir(), "definitely-absent"))).toBeNull()
  })
})

describe("createBucket", () => {
  const creds = { accessKeyId: "AKIATEST", secretAccessKey: "shh" }

  it("signs with SigV4 and states the region in the body", async () => {
    let seen: { url: string; method?: string; auth?: string; body?: string } = { url: "" }
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      seen = {
        url: String(url),
        method: init?.method,
        auth: (init?.headers as Record<string, string>)?.Authorization,
        body: typeof init?.body === "string" ? init.body : undefined,
      }
      return new Response("", { status: 200 })
    })

    await createBucket("my-bucket", "eu-central-1", creds)

    expect(seen.method).toBe("PUT")
    expect(seen.url).toBe("https://my-bucket.s3.eu-central-1.amazonaws.com/")
    expect(seen.auth).toContain("AWS4-HMAC-SHA256")
    expect(seen.auth).toContain("AKIATEST")
    // Never in the URL.
    expect(seen.url).not.toContain("shh")
    expect(seen.body).toContain("<LocationConstraint>eu-central-1</LocationConstraint>")
  })

  it("throws with S3's own error text on refusal", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("<Error>BucketAlreadyExists</Error>", { status: 409 }),
    )
    await expect(createBucket("taken", "eu-central-1", creds)).rejects.toThrow(
      "BucketAlreadyExists",
    )
  })
})
