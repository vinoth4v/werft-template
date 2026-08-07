import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The tokens package ships TypeScript source rather than a build artefact.
  transpilePackages: ["@werft/tokens"],
}

export default nextConfig
