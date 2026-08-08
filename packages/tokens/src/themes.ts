import { color } from "./tokens.ts"

/**
 * Named themes: complete alternative values for the semantic tokens.
 *
 * Every theme keeps the exact same token *names* — components never change,
 * only the values behind var(--color-*) — which is the whole reason the
 * token package exists. The fleet-derived ones were sampled from real,
 * running apps (screenshots first, hex after), not imagined:
 *
 *   madras — SruthiScribe's warm paper, terracotta and serif
 *   deck   — LoopDeck's stage black and signal green
 *
 * The others are designed directions: nordlicht (graphite + aurora violet,
 * dark-leaning) and tinte (editorial ink on paper, near-monochrome).
 */

/** A per-scheme value for each of the semantic colour tokens. Widened from
 * the default `color` object, whose `as const` would otherwise pin every
 * theme to the default's exact hex strings. */
type Scheme = { light: string; dark: string }
type ColorSet = Record<keyof typeof color, Scheme>
type FontSet = { sans: string; mono: string }
type RadiusSet = { sm: string; md: string; lg: string; full: string }

export type Theme = {
  label: string
  /** One line for the picker — where this look comes from. */
  inspiration: string
  color: ColorSet
  fontFamily?: FontSet
  radius?: RadiusSet
}

export const THEMES = {
  werft: {
    label: "Werft",
    inspiration: "The default: quiet zinc and workshop blue.",
    color,
  },
  madras: {
    label: "Madras",
    inspiration: "From SruthiScribe — warm paper, terracotta, a serif voice.",
    color: {
      bg: { light: "#faf7f2", dark: "#211d18" },
      surface: { light: "#ffffff", dark: "#2c2620" },
      fg: { light: "#2d2a26", dark: "#f5efe6" },
      muted: { light: "#8a7f72", dark: "#a99c8a" },
      border: { light: "#eadfd0", dark: "#3a332a" },
      accent: { light: "#b0421f", dark: "#d96a45" },
      danger: { light: "#a83232", dark: "#d97b6c" },
      success: { light: "#5a7d5a", dark: "#86b386" },
    },
    fontFamily: {
      sans: "Georgia, 'Iowan Old Style', 'Times New Roman', serif",
      mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
    },
  },
  deck: {
    label: "Deck",
    inspiration: "From LoopDeck — stage black, slate, signal green.",
    color: {
      bg: { light: "#f4f6f8", dark: "#0b0d12" },
      surface: { light: "#ffffff", dark: "#171b23" },
      fg: { light: "#16181d", dark: "#e8eaee" },
      muted: { light: "#5d6470", dark: "#8b93a1" },
      border: { light: "#dfe3e8", dark: "#262c37" },
      accent: { light: "#16a34a", dark: "#4ade80" },
      danger: { light: "#dc2626", dark: "#f87171" },
      success: { light: "#0d9488", dark: "#2dd4bf" },
    },
    radius: { sm: "0.125rem", md: "0.375rem", lg: "0.5rem", full: "9999px" },
  },
  nordlicht: {
    label: "Nordlicht",
    inspiration: "Graphite night, aurora violet.",
    color: {
      bg: { light: "#f7f7fb", dark: "#121016" },
      surface: { light: "#ffffff", dark: "#1b1822" },
      fg: { light: "#17161f", dark: "#efedf5" },
      muted: { light: "#6b6880", dark: "#9b96ad" },
      border: { light: "#e4e2ee", dark: "#2b2735" },
      accent: { light: "#6d4df6", dark: "#a18aff" },
      danger: { light: "#e5484d", dark: "#ff6369" },
      success: { light: "#2fb37e", dark: "#4cc596" },
    },
  },
  tinte: {
    label: "Tinte",
    inspiration: "Editorial ink on paper — nearly monochrome, sharp corners.",
    color: {
      bg: { light: "#ffffff", dark: "#101010" },
      surface: { light: "#f7f6f3", dark: "#1a1a1a" },
      fg: { light: "#141414", dark: "#f2f0ea" },
      muted: { light: "#5c5a54", dark: "#a5a29a" },
      border: { light: "#d8d5cd", dark: "#34322c" },
      accent: { light: "#1a1a1a", dark: "#f2f0ea" },
      danger: { light: "#b3261e", dark: "#ff7a70" },
      success: { light: "#1f7a45", dark: "#63c489" },
    },
    radius: { sm: "0.125rem", md: "0.25rem", lg: "0.375rem", full: "9999px" },
  },
} as const satisfies Record<string, Theme>

export type ThemeName = keyof typeof THEMES

export const THEME_NAMES = Object.keys(THEMES) as ThemeName[]
