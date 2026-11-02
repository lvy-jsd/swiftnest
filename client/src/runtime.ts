/** Web builds must not import or invoke native APIs unconditionally. */
export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

/** True when the main pointer is precise (mouse or trackpad), i.e. a keyboard shortcut hint makes sense. */
export function hasPrecisePointer(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: fine)").matches;
}
