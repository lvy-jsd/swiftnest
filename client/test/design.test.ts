import { describe, expect, it } from "vitest";
import { contrastPairs, contrastRatio, generatePalette, guardContrast, oklchToSrgb, presets, srgbToOklch } from "../src/design/palette";
import { themeVariables } from "../src/design/theme";
import { breakpoints, durations, gutters, motionDurations, radii, spacing, typography } from "../src/design/tokens";

describe("rulebook tokens", () => {
  it("keeps the exact spacing scale and allowed radii", () => {
    expect(Object.values(spacing)).toEqual([4, 8, 12, 16, 20, 24, 32, 40, 48, 64]);
    for (const value of Object.values(spacing)) expect(value % 4).toBe(0);
    expect(radii).toEqual({ control: 12, card: 20, sheet: 28, avatar: "50%" });
    for (const radius of Object.values(radii)) expect([12, 20, 28, "50%"]).toContain(radius);
    expect(gutters).toEqual({ phone: 16, tablet: 24, desktop: 32 });
    expect(breakpoints).toEqual({ tablet: 600, desktop: 1024 });
    expect(Object.values(typography).map(({ size, lineHeight }) => [size, lineHeight])).toEqual([[28, 34], [20, 26], [17, 22], [16, 24], [15, 20], [13, 18], [12, 16]]);
  });

  it("sets every duration to zero for reduced motion, including CSS variables", () => {
    for (const value of Object.values(durations)) { expect(value).toBeGreaterThanOrEqual(150); expect(value).toBeLessThanOrEqual(300); }
    expect(motionDurations(false)).toEqual(durations);
    expect(Object.values(motionDurations(true)).every(value => value === 0)).toBe(true);
    const variables = themeVariables(presets.iris, "dark", true);
    const durationVariables = Object.entries(variables).filter(([key]) => key.startsWith("--duration-"));
    expect(durationVariables).toHaveLength(Object.keys(durations).length);
    expect(durationVariables.every(([, value]) => value === "0ms")).toBe(true);
  });
});

describe("OKLCH palettes", () => {
  for (const [preset, hue] of Object.entries(presets)) {
    for (const mode of ["light", "dark"] as const) {
      it(`${preset} / ${mode}: every declared text/background pair meets AA`, () => {
        const palette = generatePalette(hue, mode);
        expect(Object.keys(palette).sort()).toEqual(["background", "surface1", "surface2", "surface3", "textPrimary", "textSecondary", "textMuted", "border", "accent", "onAccent", "success", "warning", "danger"].sort());
        for (const { foreground, background, minimum } of contrastPairs) {
          expect(contrastRatio(palette[foreground], palette[background]), `${foreground} on ${background}`).toBeGreaterThanOrEqual(minimum);
        }
      });
    }
  }
  it("nudges an initially failing foreground in both directions", () => {
    const gray = { l: 0.6, c: 0, h: 0 };
    expect(contrastRatio(guardContrast(gray, ["#ffffff"]), "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(guardContrast(gray, ["#000000"], 7), "#000000")).toBeGreaterThanOrEqual(7);
    expect(() => guardContrast(gray, ["#ffffff", "#000000"], 7)).toThrow();
  });
  it("supports custom hues and chroma outside the preset range", () => {
    for (const hue of [-30, 0, 42, 120, 359, 720]) for (const mode of ["light", "dark"] as const) {
      const palette = generatePalette(hue, mode, { chroma: 0.3 });
      for (const pair of contrastPairs) expect(contrastRatio(palette[pair.foreground], palette[pair.background])).toBeGreaterThanOrEqual(pair.minimum);
    }
    expect(generatePalette(-30, "light")).toEqual(generatePalette(330, "light"));
    expect(() => generatePalette(NaN, "light")).toThrow(RangeError);
  });
  it("matches reference primaries, white and black, with sRGB round trips", () => {
    for (const rgb of [{ r: 0, g: 0, b: 0 }, { r: 1, g: 1, b: 1 }, { r: 1, g: 0, b: 0 }, { r: 0, g: 1, b: 0 }, { r: 0, g: 0, b: 1 }, { r: 0.2, g: 0.4, b: 0.6 }]) {
      const result = oklchToSrgb(srgbToOklch(rgb));
      for (const channel of ["r", "g", "b"] as const) expect(result[channel]).toBeCloseTo(rgb[channel], 4);
    }
    const red = srgbToOklch({ r: 1, g: 0, b: 0 });
    expect(red.l).toBeCloseTo(0.627955, 5);
    expect(red.c).toBeCloseTo(0.257683, 5);
    expect(red.h).toBeCloseTo(29.2339, 3);
    expect(contrastRatio("#000000", "#ffffff")).toBe(21);
  });
  it("round trips in-gamut OKLCH and maps out-of-gamut colors into sRGB", () => {
    const color = { l: 0.6, c: 0.08, h: 245 };
    const result = srgbToOklch(oklchToSrgb(color));
    expect(result.l).toBeCloseTo(color.l, 5);
    expect(result.c).toBeCloseTo(color.c, 5);
    expect(result.h).toBeCloseTo(color.h, 3);
    const mapped = oklchToSrgb({ l: 0.7, c: 0.5, h: 75 });
    expect(Object.values(mapped).every(channel => channel >= 0 && channel <= 1)).toBe(true);
    expect(srgbToOklch(mapped).l).toBeCloseTo(0.7, 5);
  });
});
