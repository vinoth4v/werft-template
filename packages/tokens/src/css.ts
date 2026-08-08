import { THEMES, type Theme, type ThemeName } from "./themes.ts"
import { fontFamily, fontSize, fontWeight, radius, space } from "./tokens.ts"

/**
 * Turns the tokens into CSS custom properties, for whichever theme the app
 * chose at scaffold time.
 *
 * Both the build script and the drift test call this, so there is exactly one
 * definition of what the stylesheet contains — and every theme emits exactly
 * the same property names, only different values, which is what lets a theme
 * change without a single component changing.
 */

export function resolveTheme(name: ThemeName) {
  // Widen off the specific union member so optional radius/fontFamily are
  // readable — each THEMES entry is a distinct literal type, and only the
  // common `Theme` shape guarantees those properties exist to check.
  const theme: Theme = THEMES[name]
  return {
    color: theme.color,
    space,
    radius: theme.radius ?? radius,
    fontSize,
    fontWeight,
    fontFamily: theme.fontFamily ?? fontFamily,
  }
}

function groupsFor(name: ThemeName) {
  const resolved = resolveTheme(name)
  return {
    space: resolved.space,
    radius: resolved.radius,
    "font-size": resolved.fontSize,
    "font-weight": resolved.fontWeight,
    "font-family": resolved.fontFamily,
  } as const
}

/** Every custom property name the stylesheet defines, in output order. */
export function customPropertyNames(name: ThemeName = "werft"): string[] {
  const resolved = resolveTheme(name)
  const names = Object.keys(resolved.color).map((token) => `--color-${token}`)

  for (const [group, tokens] of Object.entries(groupsFor(name))) {
    names.push(...Object.keys(tokens).map((token) => `--${group}-${token}`))
  }

  return names
}

export function renderCss(name: ThemeName = "werft"): string {
  const resolved = resolveTheme(name)
  const lines = [
    `/* Generated from src/tokens.ts (theme: ${name}) by \`pnpm build\`. Do not edit. */`,
    "",
    ":root {",
    "  color-scheme: light dark;",
    "",
    ...declarations(name, "light"),
    "}",
    "",
    "@media (prefers-color-scheme: dark) {",
    "  :root {",
    ...Object.entries(resolved.color).map(
      ([token, value]) => `    --color-${token}: ${value.dark};`,
    ),
    "  }",
    "}",
    "",
  ]

  return lines.join("\n")
}

function declarations(name: ThemeName, scheme: "light" | "dark"): string[] {
  const resolved = resolveTheme(name)
  const lines = Object.entries(resolved.color).map(
    ([token, value]) => `  --color-${token}: ${value[scheme]};`,
  )

  for (const [group, tokens] of Object.entries(groupsFor(name))) {
    lines.push("")
    lines.push(
      ...Object.entries(tokens).map(([token, value]) => `  --${group}-${token}: ${value};`),
    )
  }

  return lines
}
