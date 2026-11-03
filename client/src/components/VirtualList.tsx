import { useEffect, useRef } from 'react';
import type { Key, ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

type Props<T> = {
  items: readonly T[];
  itemKey: (item: T) => Key;
  renderItem: (item: T) => ReactNode;
  label: string;
  followEnd?: boolean;
  className?: string;
};

/** Small lists stay in normal flow; long lists and transcripts share measured virtualization. */
export function VirtualList<T>({ items, itemKey, renderItem, label, followEnd, className = '' }: Props<T>) {
  const scroll = useRef<HTMLDivElement>(null);
  const virtual = items.length > 50;
  const list = useVirtualizer({
    count: virtual ? items.length : 0,
    getScrollElement: () => scroll.current,
    estimateSize: () => 88,
    overscan: 6,
    getItemKey: (index) => itemKey(items[index]!),
  });
  useEffect(() => {
    if (!followEnd || !items.length) return;
    if (virtual) list.scrollToIndex(items.length - 1, { align: 'end' });
    else if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [items, followEnd, virtual, list]);
  // Rows are positioned divs for the virtualizer, so list semantics come from roles; the
  // scroll container takes focus so keyboard users can scroll it.
  return (
    // biome-ignore lint/a11y/useSemanticElements: see above
    // biome-ignore lint/a11y/noNoninteractiveTabindex: see above
    <div ref={scroll} className={`virtual-list ${className}`} role="list" aria-label={label} tabIndex={0}>
      {virtual ? (
        <div className="virtual-list__canvas" style={{ height: list.getTotalSize() }}>
          {list.getVirtualItems().map((row) => (
            // biome-ignore lint/a11y/useSemanticElements: virtualized row
            <div
              role="listitem"
              className="virtual-list__row"
              key={row.key}
              data-index={row.index}
              ref={list.measureElement}
              style={{ transform: `translateY(${row.start}px)` }}
            >
              {renderItem(items[row.index]!)}
            </div>
          ))}
        </div>
      ) : (
        items.map((item) => (
          // biome-ignore lint/a11y/useSemanticElements: same markup as the virtualized rows
          <div role="listitem" key={itemKey(item)}>
            {renderItem(item)}
          </div>
        ))
      )}
    </div>
  );
}
