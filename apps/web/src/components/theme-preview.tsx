"use client"

type ThemePreviewProps = {
  colors: {
    bg: { light: string; dark: string }
    surface: { light: string; dark: string }
    fg: { light: string; dark: string }
    accent: { light: string; dark: string }
  }
}

export function ThemePreview({ colors }: ThemePreviewProps) {
  return (
    <div className="theme-preview" aria-hidden="true">
      <div
        className="theme-swatch"
        style={{
          background: `linear-gradient(135deg, ${colors.bg.light} 50%, ${colors.bg.dark} 50%)`,
        }}
      />
      <div
        className="theme-swatch"
        style={{
          background: `linear-gradient(135deg, ${colors.surface.light} 50%, ${colors.surface.dark} 50%)`,
        }}
      />
      <div
        className="theme-swatch"
        style={{
          background: `linear-gradient(135deg, ${colors.fg.light} 50%, ${colors.fg.dark} 50%)`,
        }}
      />
      <div
        className="theme-swatch theme-swatch-accent"
        style={{
          background: `linear-gradient(135deg, ${colors.accent.light} 50%, ${colors.accent.dark} 50%)`,
        }}
      />
    </div>
  )
}
