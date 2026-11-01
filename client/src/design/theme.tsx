import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { PropsWithChildren } from "react";
import { generatePalette, presets } from "./palette";
import type { Mode } from "./palette";
import { breakpoints, easing, fonts, gutters, interaction, motionDurations, radii, spacing, surfaces, typography } from "./tokens";

export type ThemePreference = "system" | Mode;
const kebab = (value: string) => value.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);

/** Pure so all exported duration variables can be checked without a browser. */
export function themeVariables(hue: number, mode: Mode, reducedMotion: boolean): Record<string, string> {
  const variables: Record<string, string> = {};
  const add = (prefix: string, values: Record<string, string | number>, suffix = "") => {
    for (const [key, value] of Object.entries(values)) variables[`--${prefix}-${kebab(key)}`] = typeof value === "number" ? `${value}${suffix}` : value;
  };
  add("color", generatePalette(hue, mode));
  add("space", spacing, "px");
  add("radius", radii, "px");
  add("gutter", gutters, "px");
  add("breakpoint", breakpoints, "px");
  add("duration", motionDurations(reducedMotion), "ms");
  add("easing", easing);
  add("font", fonts);
  for (const [name, type] of Object.entries(typography)) {
    variables[`--type-${kebab(name)}-size`] = `${type.size}px`;
    variables[`--type-${kebab(name)}-line`] = `${type.lineHeight}px`;
    variables[`--type-${kebab(name)}-weight`] = String(type.weight);
  }
  variables["--surface-blur"] = `${surfaces.blur}px`;
  variables["--sheet-shadow"] = surfaces.sheetShadow;
  variables["--min-target"] = `${interaction.minTarget}px`;
  variables["--press-scale"] = String(interaction.pressScale);
  return variables;
}

function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

type Theme = {
  preference: ThemePreference;
  setPreference: (value: ThemePreference) => void;
  accentHue: number;
  setAccentHue: (value: number) => void;
  mode: Mode;
  reduceMotion: boolean;
  setReduceMotion: (value: boolean) => void;
  reducedMotion: boolean;
  reduceTransparency: boolean;
  setReduceTransparency: (value: boolean) => void;
};
const ThemeContext = createContext<Theme | null>(null);

export function ThemeProvider({ children }: PropsWithChildren) {
  const [preference, setPreference] = useState<ThemePreference>("system");
  const [accentHue, setAccentHue] = useState<number>(presets.iris);
  const [reduceMotion, setReduceMotion] = useState(false);
  const [reduceTransparency, setReduceTransparency] = useState(false);
  const systemDark = useMedia("(prefers-color-scheme: dark)");
  const systemReduceMotion = useMedia("(prefers-reduced-motion: reduce)");
  const systemReduceTransparency = useMedia("(prefers-reduced-transparency: reduce)");
  const mode = preference === "system" ? systemDark ? "dark" : "light" : preference;
  const reducedMotion = reduceMotion || systemReduceMotion;
  const variables = useMemo(() => themeVariables(accentHue, mode, reducedMotion), [accentHue, mode, reducedMotion]);

  useEffect(() => {
    const root = document.documentElement;
    const previous = Object.keys(variables).map(key => [key, root.style.getPropertyValue(key)] as const);
    for (const [key, value] of Object.entries(variables)) root.style.setProperty(key, value);
    root.style.colorScheme = mode;
    root.dataset.theme = mode;
    root.dataset.reduceMotion = String(reducedMotion);
    root.dataset.reduceTransparency = String(reduceTransparency || systemReduceTransparency);
    return () => {
      for (const [key, value] of previous) value ? root.style.setProperty(key, value) : root.style.removeProperty(key);
      root.style.removeProperty("color-scheme");
      delete root.dataset.theme;
      delete root.dataset.reduceMotion;
      delete root.dataset.reduceTransparency;
    };
  }, [variables, mode, reducedMotion, reduceTransparency, systemReduceTransparency]);

  return <ThemeContext value={{ preference, setPreference, accentHue, setAccentHue, mode, reduceMotion, setReduceMotion, reducedMotion, reduceTransparency, setReduceTransparency }}>{children}</ThemeContext>;
}

export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error("useTheme requires ThemeProvider");
  return theme;
}
