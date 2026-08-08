/**
 * Where an app lives: one choice co-locating its database, its functions and
 * its bucket, instead of three independently-defaulted regions an ocean
 * apart.
 *
 * Every id here was validated against the real APIs before being offered —
 * Neon by creating (and deleting) a project in each, Vercel by PATCHing
 * serverlessFunctionRegion and reading it back.
 */
export const REGIONS = {
  "us-east": { label: "US East", neon: "aws-us-east-2", vercel: "iad1", aws: "us-east-2" },
  "eu-central": {
    label: "Europe (Frankfurt)",
    neon: "aws-eu-central-1",
    vercel: "fra1",
    aws: "eu-central-1",
  },
  "us-west": { label: "US West", neon: "aws-us-west-2", vercel: "sfo1", aws: "us-west-2" },
} as const

export type RegionKey = keyof typeof REGIONS

export const REGION_KEYS = Object.keys(REGIONS) as RegionKey[]
