import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { renderCss } from "../src/css.ts"

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const outputPath = join(packageRoot, "dist", "tokens.css")

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, renderCss(), "utf8")

console.log(`wrote ${outputPath}`)
