import { describe, expect, it } from "vitest"
import { bucketPolicy, iamCall } from "./iam.ts"

const creds = { accessKeyId: "AKIATEST", secretAccessKey: "shh" }

function stub(captured: { url?: string; body?: string; auth?: string }): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    captured.url = String(url)
    captured.body = typeof init?.body === "string" ? init.body : undefined
    captured.auth = (init?.headers as Record<string, string>)?.Authorization
    return new Response("<ok/>", { status: 200 })
  }) as typeof fetch
}

describe("iamCall", () => {
  it("signs SigV4 for the iam service in us-east-1, POSTed as a form", async () => {
    const seen: { url?: string; body?: string; auth?: string } = {}
    await iamCall({ Action: "GetUser" }, creds, new Date("2026-08-08T00:00:00Z"), stub(seen))

    expect(seen.url).toBe("https://iam.amazonaws.com/")
    expect(seen.body).toContain("Action=GetUser")
    expect(seen.body).toContain("Version=2010-05-08")
    expect(seen.auth).toContain("AWS4-HMAC-SHA256")
    expect(seen.auth).toContain("/us-east-1/iam/aws4_request")
    expect(seen.auth).toContain("AKIATEST")
    // The secret never appears anywhere in the request.
    expect(`${seen.url}${seen.body}${seen.auth}`).not.toContain("shh")
  })

  it("throws with the AWS error body on a non-2xx", async () => {
    const failing = (async () =>
      new Response("<Error>EntityAlreadyExists</Error>", { status: 409 })) as typeof fetch
    await expect(iamCall({ Action: "CreateUser" }, creds, new Date(), failing)).rejects.toThrow(
      "EntityAlreadyExists",
    )
  })
})

describe("bucketPolicy", () => {
  it("scopes to exactly the one bucket, nothing account-wide", () => {
    const policy = JSON.parse(bucketPolicy("my-bucket"))
    const resources = policy.Statement.flatMap((s: { Resource: string }) => s.Resource)
    expect(resources).toEqual(["arn:aws:s3:::my-bucket/*", "arn:aws:s3:::my-bucket"])
    // No wildcards that would reach other buckets or other services.
    expect(JSON.stringify(policy)).not.toContain('"*"')
  })
})
