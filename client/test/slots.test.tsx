import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Slot, SlotRegistryProvider } from '../src/components/Slot';
import { createSlotRegistry, layoutSlot, panelsInSlot, type PanelDef } from '../src/components/slots';
import { I18nProvider } from '../src/i18n';

function panel(overrides: Partial<PanelDef> & Pick<PanelDef, 'id'>): PanelDef {
  return { slot: 'left', titleKey: 'chats', minWidth: 200, component: () => null, ...overrides };
}

function registry(...panels: PanelDef[]) {
  return createSlotRegistry(panels);
}

function renderSlot(slot: 'topbar' | 'left' | 'main' | 'right' | 'overlay', current: ReturnType<typeof registry>) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <SlotRegistryProvider registry={current}>
        <Slot id={slot} as="aside" className="sidebar" label="Sidebar" />
      </SlotRegistryProvider>
    </I18nProvider>,
  );
}

describe('slot registry', () => {
  it('orders panels by order, then id, so insertion never decides the layout', () => {
    const left = registry(
      panel({ id: 'left.second', order: 2 }),
      panel({ id: 'left.first', order: 1 }),
      panel({ id: 'left.third', order: 2 }),
    );
    expect(left.getSnapshot().map((entry) => entry.id)).toEqual(['left.first', 'left.second', 'left.third']);
  });

  it('rejects duplicate ids instead of rendering two panels into one track', () => {
    const left = registry(panel({ id: 'left.sidebar' }));
    expect(() => left.register(panel({ id: 'left.sidebar' }))).toThrow(/already registered/);
  });

  it('removes a panel when its disposer runs, and ignores a stale disposer', () => {
    const left = registry();
    const dispose = left.register(panel({ id: 'left.a' }));
    const disposeOther = left.register(panel({ id: 'left.b' }));
    dispose();
    expect(left.getSnapshot().map((entry) => entry.id)).toEqual(['left.b']);
    disposeOther();
    dispose();
    expect(left.getSnapshot()).toEqual([]);
  });

  it('notifies subscribers on register and dispose', () => {
    const left = registry();
    const listener = vi.fn();
    const unsubscribe = left.subscribe(listener);
    const dispose = left.register(panel({ id: 'left.a' }));
    dispose();
    unsubscribe();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('rejects panels the layout cannot honour', () => {
    expect(() => registry(panel({ id: 'left.upper' }))).not.toThrow();
    expect(() => registry(panel({ id: 'sidebar' }))).toThrow(/dotted/);
    expect(() => registry(panel({ id: 'left.a', minWidth: 13 }))).toThrow(/multiple of 4/);
    expect(() => registry(panel({ id: 'left.a', titleKey: '' }))).toThrow(/titleKey/);
    expect(() => registry({ ...panel({ id: 'left.a' }), slot: 'footer' as never })).toThrow(/unknown slot/);
  });

  it('selects panels for one slot only', () => {
    const all = registry(panel({ id: 'left.a' }), panel({ id: 'left.b' }), panel({ id: 'right.a', slot: 'right' }));
    expect(panelsInSlot(all.getSnapshot(), 'left').map((entry) => entry.id)).toEqual(['left.a', 'left.b']);
    expect(panelsInSlot(all.getSnapshot(), 'right').map((entry) => entry.id)).toEqual(['right.a']);
  });
});

describe('slot layout by available width', () => {
  const panels = [panel({ id: 'left.a', minWidth: 240 }), panel({ id: 'left.b', minWidth: 200 })];

  it('keeps every panel before the first measurement', () => {
    expect(layoutSlot(panels, Number.POSITIVE_INFINITY, 12)).toEqual({ visible: panels, collapsed: [] });
  });

  it('shows what fits and folds the rest instead of squeezing them', () => {
    const layout = layoutSlot(panels, 400, 12);
    expect(layout.visible.map((entry) => entry.id)).toEqual(['left.a']);
    expect(layout.collapsed.map((entry) => entry.id)).toEqual(['left.b']);
  });

  it('counts the gap only between panels that are already visible', () => {
    const layout = layoutSlot(panels, 452, 12);
    expect(layout.collapsed).toEqual([]);
  });

  it('keeps a panel that only fits after a wider one was folded', () => {
    const mixed = [panel({ id: 'left.wide', minWidth: 320 }), panel({ id: 'left.narrow', minWidth: 160 })];
    const layout = layoutSlot(mixed, 200, 0);
    expect(layout.visible.map((entry) => entry.id)).toEqual(['left.narrow']);
  });
});

describe('slot rendering', () => {
  it('paints the slot element with its data marker and the panels inside it', () => {
    const html = renderSlot(
      'left',
      registry(
        panel({ id: 'left.sidebar', component: () => <p>sidebar panel</p> }),
        panel({ id: 'left.right', slot: 'right', component: () => <p>rail panel</p> }),
      ),
    );
    expect(html).toContain('data-slot="left"');
    expect(html).toContain('class="slot sidebar"');
    expect(html).toContain('sidebar panel');
    expect(html).not.toContain('rail panel');
  });

  it('shows a panel that needs more width than a phone has when nothing was measured', () => {
    const html = renderSlot(
      'left',
      registry(panel({ id: 'left.sidebar', minWidth: 1200, component: () => <p>wide panel</p> })),
    );
    expect(html).toContain('wide panel');
  });
});
