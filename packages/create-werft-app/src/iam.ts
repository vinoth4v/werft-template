import { createHash, createHmac } from "node:crypto"
import type { AwsCredentials } from "./s3.ts"

/**
 * Mint and revoke a per-app IAM user whose only power is its own S3 bucket.
 *
 * This is what makes "everything configured from Werft, I never touch the AWS
 * console" true rather than aspirational: the admin key exists once, on the
 * werft-template runner, and never reaches an app. Each --with-s3 app instead
 * gets a fresh user (`werft-<app>`) with an inline policy scoped to exactly
 * `arn:aws:s3:::<bucket>` and its objects, and that user's own access key —
 * so a leak from one app cannot touch another app's bucket or anything else
 * in the account.
 *
 * Hand-rolled SigV4 over fetch, zero dependencies — same choice as s3.ts, and
 * verified live (a full mint→policy→key→revoke cycle) before being wired in.
 * IAM is a global service: always signed for us-east-1, service "iam", as a
 * form-POST to iam.amazonaws.com (a different canonical shape from S3's
 * virtual-hosted GET/PUT, so the signer is separate rather than shared).
 */

const IAM_HOST = "iam.amazonaws.com"
const IAM_REGION = "us-east-1"
const IAM_VERSION = "2010-05-08"

export type AppAwsUser = {
  userName: string
  accessKeyId: string
  secretAccessKey: string
}

const sha256 = (data: string): string => createHash("sha256").update(data).digest("hex")
const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac("sha256", key).update(data).digest()

export async function iamCall(
  params: Record<string, string>,
  creds: AwsCredentials,
  now: Date = new Date(),
  doFetch: typeof fetch = fetch,
): Promise<string> {
  const body = new URLSearchParams({ ...params, Version: IAM_VERSION }).toString()
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "")
  const dateStamp = amzDate.slice(0, 8)
  const contentType = "application/x-www-form-urlencoded; charset=utf-8"
  const payloadHash = sha256(body)

  const canonicalHeaders = `content-type:${contentType}\nhost:${IAM_HOST}\nx-amz-date:${amzDate}\n`
  const signedHeaderNames = "content-type;host;x-amz-date"
  const canonicalRequest = ["POST", "/", "", canonicalHeaders, signedHeaderNames, payloadHash].join(
    "\n",
  )

  const scope = `${dateStamp}/${IAM_REGION}/iam/aws4_request`
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n")
  const kSigning = hmac(
    hmac(hmac(hmac(`AWS4${creds.secretAccessKey}`, dateStamp), IAM_REGION), "iam"),
    "aws4_request",
  )
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex")

  const response = await doFetch(`https://${IAM_HOST}/`, {
    method: "POST",
    headers: {
      "Content-Type": contentType,
      "X-Amz-Date": amzDate,
      Authorization: `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaderNames}, Signature=${signature}`,
    },
    body,
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`IAM ${params.Action} -> ${response.status}: ${text.slice(0, 300)}`)
  }
  return text
}

/** The least privilege an app needs over its own bucket: read/write/delete
 * objects, and list them. Nothing account-wide, nothing about other buckets. */
export function bucketPolicy(bucket: string): string {
  return JSON.stringify({
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        Resource: `arn:aws:s3:::${bucket}/*`,
      },
      { Effect: "Allow", Action: ["s3:ListBucket"], Resource: `arn:aws:s3:::${bucket}` },
    ],
  })
}

const extract = (xml: string, tag: string): string =>
  new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(xml)?.[1] ?? ""

/**
 * Creates the user, attaches the bucket-scoped policy, and returns a fresh
 * access key. The user name is derived from the app so it is recognisable in
 * the console the operator is trying never to open.
 */
export async function createAppAwsUser(
  appName: string,
  bucket: string,
  creds: AwsCredentials,
): Promise<AppAwsUser> {
  const userName = `werft-${appName}`
  await iamCall({ Action: "CreateUser", UserName: userName, Path: "/werft/" }, creds)
  await iamCall(
    {
      Action: "PutUserPolicy",
      UserName: userName,
      PolicyName: "werft-bucket-access",
      PolicyDocument: bucketPolicy(bucket),
    },
    creds,
  )
  const keyXml = await iamCall({ Action: "CreateAccessKey", UserName: userName }, creds)
  return {
    userName,
    accessKeyId: extract(keyXml, "AccessKeyId"),
    secretAccessKey: extract(keyXml, "SecretAccessKey"),
  }
}

/**
 * Full teardown, in the order IAM requires: the access key and inline policy
 * must go before the user itself. Best-effort per step so a partial mint still
 * unwinds. Returns true only if the user delete succeeded.
 */
export async function deleteAppAwsUser(
  userName: string,
  accessKeyId: string,
  creds: AwsCredentials,
): Promise<boolean> {
  try {
    if (accessKeyId) {
      await iamCall(
        { Action: "DeleteAccessKey", UserName: userName, AccessKeyId: accessKeyId },
        creds,
      ).catch(() => {})
    }
    await iamCall(
      { Action: "DeleteUserPolicy", UserName: userName, PolicyName: "werft-bucket-access" },
      creds,
    ).catch(() => {})
    await iamCall({ Action: "DeleteUser", UserName: userName }, creds)
    return true
  } catch {
    return false
  }
}
