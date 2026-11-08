/**
 * The five-slot layout, as data instead of JSX branches.
 *
 * `product.md` §5 fixes the main layout to five slots: top bar, left list, main
 * area, right rail and overlay. A feature registers a panel into one of them and
 * never re-arranges the shell, so adding a page cannot break another page.
 *
 * A panel declares a stable id, its slot, an i18n title key and the CSS width it
 * needs to stay usable. The slot shows the panels that fit and moves the rest into
 * a reachable overflow entry instead of squeezing them.
 */
import type { ComponentType } from 'react';

export const SLOT_IDS = ['topbar', 'left', 'main', 'right', 'overlay'] as const;
export type SlotId = (typeof SLOT_IDS)[number];

export interface PanelDef {
  /** Stable, dotted id such as `main.chat`. Duplicate ids are rejected. */
  readonly id: string;
  readonly slot: SlotId;
  /** i18n key of the panel title: the accessible name and the overflow entry's label. */
  readonly titleKey: string;
  /**
   * CSS px the panel needs to stay usable, a multiple of 4.
   *
   * `0` means "always render": the main area and sheets have no width of their own
   * and must never be folded away. Other panels are folded into the slot's overflow
   * entry rather than squeezed below this width.
   */
  readonly minWidth: number;
  /** Display order, and the keep order when a slot is too narrow: earlier survives. */
  readonly order?: number;
  /** Remount key for panels whose state belongs to one subject (one chat, one device). */
  readonly key?: string | number;
  /** Zero-prop component. The shell closes over the context it needs when it builds the panel. */
  readonly component: ComponentType;
}

const ID = /^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/;

/** Reject a malformed panel at registration time instead of rendering a mystery box. */
export function assertPanel(panel: PanelDef): void {
  const where = `panel "${String(panel.id)}"`;
  if (!ID.test(panel.id)) throw new Error(`${where}: id must be dotted lower-case, e.g. "left.sidebar"`);
  if (!SLOT_IDS.includes(panel.slot)) throw new Error(`${where}: unknown slot "${String(panel.slot)}"`);
  if (!panel.titleKey) throw new Error(`${where}: titleKey is required for its accessible name`);
  if (!Number.isInteger(panel.minWidth) || panel.minWidth < 0 || panel.minWidth % 4 !== 0)
    throw new Error(`${where}: minWidth must be a multiple of 4 (0 means always render)`);
  if (panel.order !== undefined && !Number.isFinite(panel.order))
    throw new Error(`${where}: order must be a finite number`);
}

/** Ascending order; ties break on id so the result never depends on insertion. */
export function comparePanels(a: PanelDef, b: PanelDef): number {
  const order = (a.order ?? 0) - (b.order ?? 0);
  if (order !== 0) return order;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function panelsInSlot(panels: readonly PanelDef[], slot: SlotId): PanelDef[] {
  return panels.filter((panel) => panel.slot === slot).sort(comparePanels);
}

export interface SlotLayout {
  visible: PanelDef[];
  collapsed: PanelDef[];
}

/**
 * Split a slot's panels by the width it actually has.
 *
 * `Number.POSITIVE_INFINITY` (unmeasured, server render) keeps every panel visible:
 * a layout we cannot measure must not silently hide a page.
 */
export function layoutSlot(panels: readonly PanelDef[], availableWidth: number, gap = 0): SlotLayout {
  const ordered = [...panels].sort(comparePanels);
  const visible: PanelDef[] = [];
  const collapsed: PanelDef[] = [];
  let used = 0;
  for (const panel of ordered) {
    const next = used + (visible.length ? gap : 0) + panel.minWidth;
    if (next <= availableWidth) {
      visible.push(panel);
      used = next;
    } else collapsed.push(panel);
  }
  return { visible, collapsed };
}

export interface SlotRegistry {
  /** Register a panel and return the disposer that removes it and its listeners. */
  register(panel: PanelDef): () => void;
  getSnapshot(): readonly PanelDef[];
  subscribe(listener: () => void): () => void;
}

/**
 * The live panel set. Built-in panels are passed in at construction; panels that
 * arrive later (a plugin host) use `register` and drop themselves on unload.
 */
export function createSlotRegistry(initial: readonly PanelDef[] = []): SlotRegistry {
  const panels = new Map<string, PanelDef>();
  const listeners = new Set<() => void>();
  let snapshot: readonly PanelDef[] = [];

  const settle = () => {
    snapshot = [...panels.values()].sort(comparePanels);
    for (const listener of listeners) listener();
  };

  const registry: SlotRegistry = {
    register(panel) {
      assertPanel(panel);
      if (panels.has(panel.id)) throw new Error(`panel "${panel.id}" is already registered`);
      panels.set(panel.id, panel);
      settle();
      // A stale disposer must not remove a panel that took the id over.
      return () => {
        if (panels.get(panel.id) !== panel) return;
        panels.delete(panel.id);
        settle();
      };
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };

  for (const panel of initial) registry.register(panel);
  return registry;
}
