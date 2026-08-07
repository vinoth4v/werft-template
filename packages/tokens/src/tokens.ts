/**
 * The design tokens. This file is the source of truth — the stylesheet is
 * generated from it, so never edit the two in parallel.
 *
 * Deliberately small. A token set you can hold in your head gets used; one
 * with four hundred entries gets ignored and worked around.
 */

/**
 * Raw values. Not for use in components — they carry no meaning, so a change
 * here is a change to "what colour is this", not "what is this colour for".
 */
const scale = {
  white: "#ffffff",
  zinc50: "#fafafa",
  zinc200: "#e4e4e7",
  zinc400: "#a1a1aa",
  zinc600: "#52525b",
  zinc800: "#27272a",
  zinc900: "#18181b",
  blue400: "#60a5fa",
  blue600: "#2563eb",
  red400: "#f87171",
  red600: "#dc2626",
} as const

/** Semantic colours. Each names a job, and carries a value per scheme. */
export const color = {
  bg: { light: scale.zinc50, dark: scale.zinc900 },
  surface: { light: scale.white, dark: scale.zinc800 },
  fg: { light: scale.zinc900, dark: scale.zinc50 },
  muted: { light: scale.zinc600, dark: scale.zinc400 },
  border: { light: scale.zinc200, dark: scale.zinc800 },
  accent: { light: scale.blue600, dark: scale.blue400 },
  danger: { light: scale.red600, dark: scale.red400 },
} as const

export const space = {
  0: "0",
  1: "0.25rem",
  2: "0.5rem",
  3: "0.75rem",
  4: "1rem",
  6: "1.5rem",
  8: "2rem",
  12: "3rem",
} as const

export const radius = {
  sm: "0.25rem",
  md: "0.5rem",
  lg: "0.75rem",
  full: "9999px",
} as const

export const fontSize = {
  sm: "0.875rem",
  base: "1rem",
  lg: "1.125rem",
  xl: "1.5rem",
  "2xl": "2rem",
} as const

export const fontWeight = {
  normal: "400",
  medium: "500",
  semibold: "600",
} as const

export const fontFamily = {
  sans: "ui-sans-serif, system-ui, sans-serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
} as const

export type ColorToken = keyof typeof color
export type SpaceToken = keyof typeof space
export type RadiusToken = keyof typeof radius
export type FontSizeToken = keyof typeof fontSize
export type FontWeightToken = keyof typeof fontWeight
export type FontFamilyToken = keyof typeof fontFamily
