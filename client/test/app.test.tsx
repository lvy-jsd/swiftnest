import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { App, chatFromHash } from "../src/App";
import { ThemeProvider } from "../src/design/theme";
import { I18nProvider, en, translate, zhCN } from "../src/i18n";
import { isTauriRuntime } from "../src/runtime";

describe("web shell and translations", () => {
  it("renders in English and Chinese without a native runtime", () => {
    expect(isTauriRuntime()).toBe(false);
    for (const locale of ["en", "zh-CN"] as const) {
      const html = renderToStaticMarkup(<ThemeProvider><I18nProvider initialLocale={locale}><App /></I18nProvider></ThemeProvider>);
      expect(html).toContain(translate(locale, "chats"));
      expect(html).toContain(translate(locale, "sampleTitle"));
      expect(html).toContain("#/chats/fresh-start");
    }
  });
  it("keeps the string tables complete", () => { expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort()); });
  it("detects the Tauri marker and leaves ordinary web windows native-free", () => {
    try {
      vi.stubGlobal("window", {});
      expect(isTauriRuntime()).toBe(false);
      vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
      expect(isTauriRuntime()).toBe(true);
      vi.stubGlobal("window", { __TAURI_INTERNALS__: undefined });
      expect(isTauriRuntime()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it("recognizes chat deep links and falls back for unknown paths", () => {
    expect(chatFromHash("#/chats/fresh-start")?.id).toBe("fresh-start");
    expect(chatFromHash("#/chats/weekend")?.id).toBe("weekend");
    expect(chatFromHash("#/chats/missing")).toBeUndefined();
    expect(chatFromHash("#/")).toBeUndefined();
  });
});
