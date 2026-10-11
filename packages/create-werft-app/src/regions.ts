/**
 * Where an app's optional S3 bucket lives (--with-s3). The app itself and its
 * database always run on the home server; this only places the bucket.
 */
export const REGIONS = {
  "us-east": { label: "US East", aws: "us-east-2" },
  "eu-central": {
    label: "Europe (Frankfurt)",
    aws: "eu-central-1",
  },
  "us-west": { label: "US West", aws: "us-west-2" },
} as const

export type RegionKey = keyof typeof REGIONS

export const REGION_KEYS = Object.keys(REGIONS) as RegionKey[]
