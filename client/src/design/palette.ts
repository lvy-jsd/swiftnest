export type Mode = "light" | "dark";
export type RGB = { r: number; g: number; b: number };
export type OKLCH = { l: number; c: number; h: number };
export const presets = { iris: 285, ocean: 245, jade: 155, amber: 75, rose: 15 } as const;

const clamp = (x: number) => Math.max(0, Math.min(1, x));
const linearize = (x: number) => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
const encode = (x: number) => x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;

function convert({ l, c, h }: OKLCH): RGB {
  const a = c * Math.cos(h * Math.PI / 180);
  const b = c * Math.sin(h * Math.PI / 180);
  const ll = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const ss = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: encode(4.0767416621 * ll - 3.3077115913 * mm + 0.2309699292 * ss),
    g: encode(-1.2684380046 * ll + 2.6097574011 * mm - 0.3413193965 * ss),
    b: encode(-0.0041960863 * ll - 0.7034186147 * mm + 1.707614701 * ss),
  };
}

/** Gamut-map by reducing chroma, preserving lightness and hue. No browser color support needed. */
export function oklchToSrgb(color: OKLCH): RGB {
  const input = { l: clamp(color.l), c: Math.max(0, color.c), h: color.h };
  let rgb = convert(input);
  const inGamut = (value: RGB) => Object.values(value).every(x => x >= -1e-7 && x <= 1 + 1e-7);
  if (!inGamut(rgb)) {
    let low = 0;
    let high = input.c;
    for (let i = 0; i < 24; i++) {
      const c = (low + high) / 2;
      if (inGamut(convert({ ...input, c }))) low = c;
      else high = c;
    }
    rgb = convert({ ...input, c: low });
  }
  return { r: clamp(rgb.r), g: clamp(rgb.g), b: clamp(rgb.b) };
}

export function srgbToOklch(rgb: RGB): OKLCH {
  const r = linearize(rgb.r), g = linearize(rgb.g), b = linearize(rgb.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, c: Math.hypot(a, bb), h: (Math.atan2(bb, a) * 180 / Math.PI + 360) % 360 };
}

function hex(rgb: RGB): string {
  return "#" + [rgb.r, rgb.g, rgb.b].map(x => Math.round(clamp(x) * 255).toString(16).padStart(2, "0")).join("");
}

function fromHex(color: string): RGB {
  if (!/^#[\da-f]{6}$/i.test(color)) throw new Error("Expected a six-digit sRGB hex color.");
  return { r: parseInt(color.slice(1, 3), 16) / 255, g: parseInt(color.slice(3, 5), 16) / 255, b: parseInt(color.slice(5, 7), 16) / 255 };
}

export function contrastRatio(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const { r, g, b } = fromHex(color);
    return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
  };
  const a = luminance(foreground), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Nudge OKLCH lightness toward the higher-contrast endpoint; test the serialized sRGB result. */
export function guardContrast(color: OKLCH, backgrounds: readonly string[], minimum = 4.5): string {
  const css = (l: number) => hex(oklchToSrgb({ ...color, l }));
  const score = (value: string) => Math.min(...backgrounds.map(bg => contrastRatio(value, bg)));
  const direction = score(css(0)) > score(css(1)) ? -1 : 1;
  for (let i = 0; i <= 200; i++) {
    const result = css(clamp(color.l + direction * i * 0.005));
    if (score(result) >= minimum) return result;
  }
  throw new Error("No foreground can meet the requested contrast against these backgrounds.");
}

export type Palette = Record<"background" | "surface1" | "surface2" | "surface3" | "textPrimary" | "textSecondary" | "textMuted" | "border" | "accent" | "onAccent" | "success" | "warning" | "danger", string>;
export type PaletteOptions = { chroma?: number };
export const backgroundTokens = ["background", "surface1", "surface2", "surface3"] as const;
// Status and accent colors may label text or icons. Use the stronger body-text threshold for both.
export const contrastPairs = [
  ...backgroundTokens.flatMap(background => (["textPrimary", "textSecondary", "textMuted", "accent", "success", "warning", "danger"] as const).map(foreground => ({ foreground, background, minimum: 4.5 }))),
  { foreground: "onAccent", background: "accent", minimum: 4.5 },
] as const satisfies readonly { foreground: keyof Palette; background: keyof Palette; minimum: number }[];

export function generatePalette(accentHue: number, mode: Mode, opts: PaletteOptions = {}): Palette {
  if (!Number.isFinite(accentHue) || (opts.chroma !== undefined && !Number.isFinite(opts.chroma))) throw new RangeError("Hue and chroma must be finite.");
  const h = (accentHue % 360 + 360) % 360;
  const c = Math.max(0, Math.min(0.3, opts.chroma ?? 0.16));
  const dark = mode === "dark";
  const color = (l: number, chroma = 0.012, hue = h) => hex(oklchToSrgb({ l, c: chroma, h: hue }));
  const bases = { background: color(dark ? 0.16 : 0.98), surface1: color(dark ? 0.20 : 1, 0), surface2: color(dark ? 0.24 : 0.96), surface3: color(dark ? 0.28 : 0.92) };
  const backgrounds = Object.values(bases);
  const text = (l: number, chroma = 0.012, hue = h) => guardContrast({ l, c: chroma, h: hue }, backgrounds);
  const accent = text(dark ? 0.76 : 0.50, c);
  return {
    ...bases,
    textPrimary: text(dark ? 0.94 : 0.20),
    textSecondary: text(dark ? 0.80 : 0.40),
    textMuted: text(dark ? 0.68 : 0.52),
    border: color(dark ? 0.40 : 0.80),
    accent,
    onAccent: guardContrast({ l: dark ? 0.16 : 1, c: 0, h }, [accent]),
    success: text(dark ? 0.78 : 0.48, 0.14, 150),
    warning: text(dark ? 0.82 : 0.48, 0.14, 80),
    danger: text(dark ? 0.76 : 0.50, 0.18, 25),
  };
}
