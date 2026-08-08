import { createHash, createHmac } from "node:crypto"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * The two S3 operations the scaffold needs — create a bucket, delete a
 * bucket — over hand-rolled SigV4 on global fetch, keeping this package at
 * zero dependencies. The AWS SDK would be ~10MB of node_modules for two
 * requests whose signing algorithm is a page of documented HMAC chaining.
 *
 * Per-app buckets are already this fleet's real pattern: six of them
 * existed (adjutant-files-*, editkumpel-videos, stagegrid-audio-*, …)
 * before the scaffold learned to make them.
 */

export type AwsCredentials = {
  accessKeyId: string
  secretAccessKey: string
}

/**
 * Environment first (how CI runners inject theirs), then the default profile
 * in ~/.aws/credentials — the same file the aws CLI itself reads.
 */
export async function resolveAwsCredentials(
  credentialsPath: string = join(homedir(), ".aws", "credentials"),
): Promise<AwsCredentials | null> {
  const fromEnv = {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "",
  }
  if (fromEnv.accessKeyId && fromEnv.secretAccessKey) return fromEnv

  const text = await readFile(credentialsPath, "utf8").catch(() => "")
  // The [default] profile only — Werft is a single-operator system.
  const section = /\[default\]([^[]*)/.exec(text)?.[1] ?? ""
  const accessKeyId = /aws_access_key_id\s*=\s*(\S+)/.exec(section)?.[1] ?? ""
  const secretAccessKey = /aws_secret_access_key\s*=\s*(\S+)/.exec(section)?.[1] ?? ""

  return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : null
}

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex")
const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac("sha256", key).update(data).digest()

/** SigV4 for a request with no query string and a possibly-empty body. */
function signedHeaders(
  method: "GET" | "PUT" | "DELETE",
  host: string,
  body: string,
  region: string,
  creds: AwsCredentials,
  now: Date = new Date(),
  canonicalUri = "/",
  canonicalQuery = "",
): Record<string, string> {
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "")
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = sha256(body)

  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`
  const signedHeaderNames = "host;x-amz-content-sha256;x-amz-date"
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaderNames,
    payloadHash,
  ].join("\n")

  const scope = `${dateStamp}/${region}/s3/aws4_request`
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n")

  const kDate = hmac(`AWS4${creds.secretAccessKey}`, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, "s3")
  const kSigning = hmac(kService, "aws4_request")
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex")

  return {
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
    Authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames}, Signature=${signature}`,
  }
}

export async function createBucket(
  bucket: string,
  region: string,
  creds: AwsCredentials,
): Promise<void> {
  const host = `${bucket}.s3.${region}.amazonaws.com`
  // Everywhere except us-east-1 requires the location to be stated in the
  // body. This scaffold never offers us-east-1, but handle it anyway rather
  // than leave a tripwire for whoever adds it.
  const body =
    region === "us-east-1"
      ? ""
      : `<CreateBucketConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><LocationConstraint>${region}</LocationConstraint></CreateBucketConfiguration>`

  const response = await fetch(`https://${host}/`, {
    method: "PUT",
    headers: signedHeaders("PUT", host, body, region, creds),
    body: body === "" ? undefined : body,
  })

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300)
    throw new Error(`S3 refused to create bucket ${bucket} (${response.status}): ${detail}`)
  }
}

export async function deleteBucket(
  bucket: string,
  region: string,
  creds: AwsCredentials,
): Promise<boolean> {
  const host = `${bucket}.s3.${region}.amazonaws.com`
  const response = await fetch(`https://${host}/`, {
    method: "DELETE",
    headers: signedHeaders("DELETE", host, "", region, creds),
  })
  // 404 counts: the goal is "no bucket", and it already isn't there.
  return response.ok || response.status === 404
}

/**
 * Every bucket this scaffold made for an app.
 *
 * Retirement has only the app's name to go on, and the bucket carries a random
 * suffix (`<app>-werft-<hex>`) so two apps of the same name never collide. The
 * prefix is deterministic, so the buckets can be found rather than remembered
 * — no state file to go stale, and it still works for an app scaffolded before
 * any of this existed.
 *
 * ListBuckets is global and signed for us-east-1 whatever the buckets' own
 * regions are.
 */
export async function listAppBuckets(appName: string, creds: AwsCredentials): Promise<string[]> {
  const host = "s3.amazonaws.com"
  const response = await fetch(`https://${host}/`, {
    method: "GET",
    headers: signedHeaders("GET", host, "", "us-east-1", creds),
  })
  if (!response.ok) return []

  const xml = await response.text()
  const names = [...xml.matchAll(/<Name>([^<]+)<\/Name>/g)].map((match) => match[1] ?? "")
  return names.filter((name) => name.startsWith(`${appName}-werft-`))
}

/**
 * Which region a bucket lives in, since deleting one requires knowing.
 *
 * S3 answers an empty LocationConstraint for us-east-1 — the one region this
 * scaffold never offers, but the API's oldest wart, so it is handled rather
 * than left to return "" and break the caller's URL.
 */
export async function bucketRegion(bucket: string, creds: AwsCredentials): Promise<string> {
  const host = `${bucket}.s3.amazonaws.com`
  const response = await fetch(`https://${host}/?location`, {
    method: "GET",
    headers: signedHeaders("GET", host, "", "us-east-1", creds, new Date(), "/", "location="),
  })
  if (!response.ok) return ""

  const xml = await response.text()
  const found = /<LocationConstraint[^>]*>([^<]*)<\/LocationConstraint>/.exec(xml)?.[1] ?? ""
  return found === "" ? "us-east-1" : found
}

/**
 * Deletes every object, because S3 refuses to delete a bucket that holds any.
 *
 * Loops rather than making one pass: a listing returns at most 1000 keys, and a
 * bucket with more would otherwise be reported as emptied while still holding
 * objects — after which the bucket delete fails and the app looks retired but
 * is not. Bounded so a listing that never drains cannot spin forever.
 */
export async function emptyBucket(
  bucket: string,
  region: string,
  creds: AwsCredentials,
): Promise<{ deleted: number; drained: boolean }> {
  const host = `${bucket}.s3.${region}.amazonaws.com`
  let deleted = 0

  for (let pass = 0; pass < 50; pass++) {
    const listed = await fetch(`https://${host}/?list-type=2`, {
      method: "GET",
      headers: signedHeaders("GET", host, "", region, creds, new Date(), "/", "list-type=2"),
    })
    if (!listed.ok) return { deleted, drained: listed.status === 404 }

    const xml = await listed.text()
    const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((match) => match[1] ?? "")
    if (keys.length === 0) return { deleted, drained: true }

    for (const key of keys) {
      // Each segment is encoded, but the slashes that make up the key's path
      // must stay slashes or S3 sees a different object.
      const encoded = key.split("/").map(encodeURIComponent).join("/")
      const response = await fetch(`https://${host}/${encoded}`, {
        method: "DELETE",
        headers: signedHeaders("DELETE", host, "", region, creds, new Date(), `/${encoded}`, ""),
      })
      if (response.ok || response.status === 404) deleted++
    }
  }

  return { deleted, drained: false }
}
