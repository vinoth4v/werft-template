import { describe, expect, it } from "vitest"
import { customPropertyNames, renderCss } from "./css.ts"
import { THEME_NAMES, THEMES } from "./themes.ts"
import { color } from "./tokens.ts"

describe("design tokens", () => {
  it("defines every colour for both schemes, as a hex value", () => {
    for (const [token, value] of Object.entries(color)) {
      expect(value.light, `${token}.light`).toMatch(/^#[0-9a-f]{6}$/)
      expect(value.dark, `${token}.dark`).toMatch(/^#[0-9a-f]{6}$/)
    }
  })

  it("emits a custom property for every token", () => {
    // The anti-drift guard: the stylesheet is generated, so a token added to
    // the source without reaching CSS would otherwise be silently missing.
    const css = renderCss()

    for (const name of customPropertyNames()) {
      expect(css, name).toContain(`${name}:`)
    }
  })

  it("overrides every colour, and only colours, in the dark block", () => {
    const darkBlock = renderCss().split("@media (prefers-color-scheme: dark)")[1] ?? ""

    for (const token of Object.keys(color)) {
      expect(darkBlock, token).toContain(`--color-${token}:`)
    }
    expect(darkBlock).not.toContain("--space-")
  })
})

describe("themes", () => {
  it("every theme carries every semantic colour, both schemes, valid hex", () => {
    // A theme missing one token would leave a var() unresolved only in that
    // theme — the exact class of bug a swap-the-values system must not have.
    for (const name of THEME_NAMES) {
      const themeColors = THEMES[name].color
      expect(Object.keys(themeColors).sort(), name).toEqual(Object.keys(color).sort())
      for (const [token, value] of Object.entries(themeColors)) {
        expect(value.light, `${name}.${token}.light`).toMatch(/^#[0-9a-f]{6}$/)
        expect(value.dark, `${name}.${token}.dark`).toMatch(/^#[0-9a-f]{6}$/)
      }
    }
  })

  it("every theme emits exactly the same property names as the default", () => {
    const base = customPropertyNames("werft")
    for (const name of THEME_NAMES) {
      expect(customPropertyNames(name), name).toEqual(base)
      const css = renderCss(name)
      for (const property of base) {
        expect(css, `${name} ${property}`).toContain(`${property}:`)
      }
    }
  })

  it("themes actually differ from the default where they claim to", () => {
    expect(renderCss("madras")).toContain("#b0421f")
    expect(renderCss("deck")).toContain("#4ade80")
    expect(renderCss("kimi-earth")).toContain("#b85c3e")
    expect(renderCss("kimi-terminal")).toContain("#f59e0b")
    expect(renderCss("werft")).not.toContain("#b0421f")
  })
})
