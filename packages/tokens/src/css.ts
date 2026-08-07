import { color, fontFamily, fontSize, fontWeight, radius, space } from "./tokens.ts"

/**
 * Turns the tokens into CSS custom properties.
 *
 * Both the build script and the drift test call this, so there is exactly one
 * definition of what the stylesheet contains.
 */

const GROUPS = {
  space,
  radius,
  "font-size": fontSize,
  "font-weight": fontWeight,
  "font-family": fontFamily,
} as const

/** Every custom property name the stylesheet defines, in output order. */
export function customPropertyNames(): string[] {
  const names = Object.keys(color).map((token) => `--color-${token}`)

  for (const [group, tokens] of Object.entries(GROUPS)) {
    names.push(...Object.keys(tokens).map((token) => `--${group}-${token}`))
  }

  return names
}

export function renderCss(): string {
  const lines = [
    "/* Generated from src/tokens.ts by `pnpm build`. Do not edit. */",
    "",
    ":root {",
    "  color-scheme: light dark;",
    "",
    ...declarations("light"),
    "}",
    "",
    "@media (prefers-color-scheme: dark) {",
    "  :root {",
    ...Object.entries(color).map(([token, value]) => `    --color-${token}: ${value.dark};`),
    "  }",
    "}",
    "",
  ]

  return lines.join("\n")
}

function declarations(scheme: "light" | "dark"): string[] {
  const lines = Object.entries(color).map(
    ([token, value]) => `  --color-${token}: ${value[scheme]};`,
  )

  for (const [group, tokens] of Object.entries(GROUPS)) {
    lines.push("")
    lines.push(
      ...Object.entries(tokens).map(([token, value]) => `  --${group}-${token}: ${value};`),
    )
  }

  return lines
}
