/**
 * Renders one slot of the five-slot shell.
 *
 * The slot owns visibility: it measures the width it actually has, keeps the panels
 * that fit and moves the rest into an overflow entry that stays reachable. Panels
 * never declare their own breakpoints, so a narrow slot cannot squeeze a page.
 */
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ElementType, ReactNode, RefObject } from 'react';
import { useI18n } from '../i18n';
import { Button } from './Button';
import { Sheet } from './Sheet';
import { layoutSlot, panelsInSlot, type SlotId, type SlotRegistry } from './slots';

const RegistryContext = createContext<SlotRegistry | null>(null);

export function SlotRegistryProvider({ registry, children }: { registry: SlotRegistry; children: ReactNode }) {
  return <RegistryContext value={registry}>{children}</RegistryContext>;
}

export function useSlotRegistry(): SlotRegistry {
  const registry = useContext(RegistryContext);
  if (!registry) throw new Error('useSlotRegistry requires SlotRegistryProvider');
  return registry;
}

const TAGS = { div: 'div', aside: 'aside', header: 'header', main: 'main', nav: 'nav', section: 'section' } as const;

/**
 * The slot's own content width, or `Infinity` before the first measurement.
 *
 * Unmeasured must mean "show everything": a server render or a test has no layout,
 * and hiding a page because we could not measure it is the white screen we forbid.
 */
function useMeasuredWidth(ref: RefObject<HTMLElement | null>, measure: boolean): number {
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY);
  useEffect(() => {
    const element = ref.current;
    if (!measure || !element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure, ref]);
  return width;
}

export type SlotProps = {
  id: SlotId;
  /** The element the slot paints, so the shell keeps its landmarks (`aside`, `header`, `main`). */
  as?: keyof typeof TAGS;
  className?: string;
  /** Accessible name of the slot region. Omit for purely structural slots. */
  label?: string;
  /** Px between panels in this slot. */
  gap?: number;
  /** `false` for slots that must never fold a panel away (the main area, the overlay). */
  measure?: boolean;
};

export function Slot({ id, as = 'div', className, label, gap = 0, measure = true }: SlotProps) {
  const registry = useSlotRegistry();
  const panels = useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
  const ref = useRef<HTMLElement>(null);
  const width = useMeasuredWidth(ref, measure);
  const { visible, collapsed } = layoutSlot(panelsInSlot(panels, id), width, gap);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const { t } = useI18n();
  const Tag = TAGS[as] as ElementType;

  return (
    <Tag
      ref={ref}
      className={className ? `slot ${className}` : 'slot'}
      data-slot={id}
      data-collapsed={collapsed.length ? '' : undefined}
      aria-label={label}
    >
      {visible.map((panel) => {
        const Panel = panel.component;
        return <Panel key={panel.key ?? panel.id} />;
      })}
      {collapsed.length > 0 && (
        <>
          <Button variant="soft" className="slot__overflow" onClick={() => setOverflowOpen(true)}>
            {t('slot.morePanels')}
          </Button>
          <Sheet open={overflowOpen} title={t('slot.morePanels')} onClose={() => setOverflowOpen(false)}>
            {collapsed.map((panel) => {
              const Panel = panel.component;
              return (
                <div key={panel.key ?? panel.id} className="slot__overflow-panel" data-panel={panel.id}>
                  <Panel />
                </div>
              );
            })}
          </Sheet>
        </>
      )}
    </Tag>
  );
}
