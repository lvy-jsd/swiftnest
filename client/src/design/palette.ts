export type Mode = 'light' | 'dark';
export type RGB = { r: number; g: number; b: number };
export type OKLCH = { l: number; c: number; h: number };
const clamp = (x: number) => Math.max(0, Math.min(1, x));
const linearize = (x: number) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4);
const encode = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);

function convert({ l, c, h }: OKLCH): RGB {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
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
  const inGamut = (value: RGB) => Object.values(value).every((x) => x >= -1e-7 && x <= 1 + 1e-7);
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
  const r = linearize(rgb.r),
    g = linearize(rgb.g),
    b = linearize(rgb.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return {
    l: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    c: Math.hypot(a, bb),
    h: ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360,
  };
}

function hex(rgb: RGB): string {
  return (
    '#' +
    [rgb.r, rgb.g, rgb.b]
      .map((x) =>
        Math.round(clamp(x) * 255)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
  );
}

function fromHex(color: string): RGB {
  if (!/^#[\da-f]{6}$/i.test(color)) throw new Error('Expected a six-digit sRGB hex color.');
  return {
    r: parseInt(color.slice(1, 3), 16) / 255,
    g: parseInt(color.slice(3, 5), 16) / 255,
    b: parseInt(color.slice(5, 7), 16) / 255,
  };
}

export function contrastRatio(foreground: string, background: string): number {
  const luminance = (color: string) => {
    const { r, g, b } = fromHex(color);
    return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
  };
  const a = luminance(foreground),
    b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Nudge OKLCH lightness toward the higher-contrast endpoint; test the serialized sRGB result. */
export function guardContrast(color: OKLCH, backgrounds: readonly string[], minimum = 4.5): string {
  const css = (l: number) => hex(oklchToSrgb({ ...color, l }));
  const score = (value: string) => Math.min(...backgrounds.map((bg) => contrastRatio(value, bg)));
  const direction = score(css(0)) > score(css(1)) ? -1 : 1;
  for (let i = 0; i <= 200; i++) {
    const result = css(clamp(color.l + direction * i * 0.005));
    if (score(result) >= minimum) return result;
  }
  throw new Error('No foreground can meet the requested contrast against these backgrounds.');
}

const irisLight = srgbToOklch(fromHex('#4B57D6'));
const irisDark = srgbToOklch(fromHex('#8C95F5'));
export const presets = { iris: irisLight.h, ocean: 245, jade: 155, amber: 75, rose: 15 } as const;

export type Palette = Record<
  | 'background'
  | 'backgroundEnd'
  | 'surface1'
  | 'surface2'
  | 'surface3'
  | 'textPrimary'
  | 'textSecondary'
  | 'textMuted'
  | 'border'
  | 'accent'
  | 'accentText'
  | 'onAccent'
  | 'success'
  | 'successText'
  | 'waiting'
  | 'waitingText'
  | 'dangerText'
  | 'danger',
  string
>;
export type PaletteOptions = { chroma?: number };
export const backgroundTokens = ['background', 'backgroundEnd', 'surface1', 'surface2', 'surface3'] as const;
// Text roles and primary button labels use the body-text contrast threshold.
export const contrastPairs = [
  ...backgroundTokens.flatMap((background) =>
    (
      ['textPrimary', 'textSecondary', 'textMuted', 'accentText', 'successText', 'waitingText', 'dangerText'] as const
    ).map((foreground) => ({ foreground, background, minimum: 4.5 })),
  ),
  { foreground: 'onAccent', background: 'accent', minimum: 4.5 },
] as const satisfies readonly { foreground: keyof Palette; background: keyof Palette; minimum: number }[];

const neutralSurfaces = {
  dark: {
    background: '#1B1F29',
    backgroundEnd: '#16181E',
    surface1: '#22252D',
    surface2: '#252933',
    surface3: '#292D38',
  },
  light: {
    background: '#ECF0FA',
    backgroundEnd: '#F6F5F9',
    surface1: '#FFFFFF',
    surface2: '#F0F2F9',
    surface3: '#E9EDF7',
  },
} as const;

/** Neutral surfaces stay independent of the accent. Color conversion maps only out-of-gamut hues. */
export function generatePalette(accentHue: number, mode: Mode, opts: PaletteOptions = {}): Palette {
  if (!Number.isFinite(accentHue) || (opts.chroma !== undefined && !Number.isFinite(opts.chroma)))
    throw new RangeError('Hue and chroma must be finite.');
  const dark = mode === 'dark';
  const iris = dark ? irisDark : irisLight;
  const h = (((accentHue + iris.h - irisLight.h) % 360) + 360) % 360;
  const c = Math.max(0, Math.min(0.3, opts.chroma ?? iris.c));
  const bases = neutralSurfaces[mode];
  const backgrounds = Object.values(bases);
  const readable = (value: string) => guardContrast(srgbToOklch(fromHex(value)), backgrounds);
  const accent = hex(oklchToSrgb({ ...iris, c, h }));
  const success = dark ? '#75D5A5' : '#1F8A5B';
  const waiting = dark ? '#F0B96F' : '#B25E09';
  const danger = dark ? '#F59A9A' : '#B42F2F';
  return {
    ...bases,
    textPrimary: dark ? '#ECEEF3' : '#191C24',
    textSecondary: dark ? '#A9AEBA' : '#565B67',
    // The reference #6B7080 needs a slight lightness adjustment on the gradient's top edge.
    textMuted: readable(dark ? '#969DAD' : '#6B7080'),
    border: dark ? '#434957' : '#D5DBE9',
    accent,
    accentText: readable(accent),
    onAccent: dark ? '#191C24' : '#FFFFFF',
    success,
    successText: readable(success),
    waiting,
    waitingText: readable(waiting),
    danger,
    dangerText: readable(danger),
  };
}
