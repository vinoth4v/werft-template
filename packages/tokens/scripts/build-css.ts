import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { renderCss } from "../src/css.ts"
import { THEME_NAMES, type ThemeName } from "../src/themes.ts"

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
const outputPath = join(packageRoot, "dist", "tokens.css")

/**
 * The app's chosen theme lives in theme.json next to this package — written
 * once by create-werft-app, committed with the app. Absent means the default,
 * so the template itself and every pre-theme app keep building unchanged.
 */
const themeFile = await readFile(join(packageRoot, "theme.json"), "utf8").catch(() => "")
const requested = themeFile ? (JSON.parse(themeFile) as { theme?: string }).theme : undefined
const theme = (requested ?? "werft") as ThemeName

if (!THEME_NAMES.includes(theme)) {
  console.error(`theme.json names unknown theme "${theme}" — known: ${THEME_NAMES.join(", ")}`)
  process.exit(1)
}

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, renderCss(theme), "utf8")

console.log(`wrote ${outputPath} (theme: ${theme})`)
