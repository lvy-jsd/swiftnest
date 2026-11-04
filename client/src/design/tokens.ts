/** 晨巢 design tokens. Dimensions in px; durations in ms. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
  huge: 40,
  giant: 48,
  max: 64,
} as const;
export const radii = { control: 12, card: 20, sheet: 28, pill: 999 } as const;
export const gutters = { phone: 16, tablet: 24, desktop: 32 } as const;
export const breakpoints = { tablet: 600, desktop: 1024 } as const;
export const typography = {
  largeTitle: { size: 28, lineHeight: 34, weight: 600 },
  title: { size: 20, lineHeight: 26, weight: 600 },
  headline: { size: 16, lineHeight: 24, weight: 600 },
  body: { size: 15.5, lineHeight: 27.125, weight: 400 },
  callout: { size: 15, lineHeight: 20, weight: 400 },
  footnote: { size: 13, lineHeight: 18, weight: 400 },
  caption: { size: 12, lineHeight: 16, weight: 400 },
} as const;
export const fonts = {
  sans: '"Inter Variable", "Noto Sans SC Variable", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Noto Sans CJK SC", sans-serif',
  mono: 'ui-monospace, "JetBrains Mono", monospace',
} as const;
export const durations = { press: 150, standard: 200, navigation: 250 } as const;
export const easing = { standard: 'cubic-bezier(0.2, 0, 0, 1)' } as const;
export const surfaces = {
  blur: 20,
  cardOpacity: 80,
  cardShadow: '0 2px 8px rgb(25 28 36 / 0.03), 0 12px 32px rgb(25 28 36 / 0.05)',
  sheetShadow: '0 8px 32px rgb(0 0 0 / 0.12)',
  scrim: 'rgb(0 0 0 / 0.4)',
} as const;
export const interaction = { minTarget: 44, pressScale: 0.97 } as const;

export function motionDurations(reducedMotion: boolean): Record<keyof typeof durations, number> {
  return Object.fromEntries(
    Object.entries(durations).map(([key, value]) => [key, reducedMotion ? 0 : value]),
  ) as Record<keyof typeof durations, number>;
}
