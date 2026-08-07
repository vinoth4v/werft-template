import { describe, expect, it } from "vitest"
import { customPropertyNames, renderCss } from "./css.ts"
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
