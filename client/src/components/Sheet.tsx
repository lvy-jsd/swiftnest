import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import { icons } from '../design/icons';
import { Button } from './Button';

/** Native modal gives focus trapping, Escape dismissal and an inert background. */
export function Sheet({
  open,
  onClose,
  title,
  children,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  actions: ReactNode;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { t } = useI18n();
  const Close = icons.close;
  useEffect(() => {
    const element = dialog.current;
    if (open && !element?.open) element?.showModal();
    else if (!open && element?.open) element.close();
  }, [open]);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the click closes on the backdrop; Escape closes via onCancel
    <dialog
      ref={dialog}
      className="sheet glass"
      aria-labelledby={titleId}
      onCancel={onClose}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const rect = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            onClose();
        }
      }}
    >
      <div className="sheet__grabber" aria-hidden="true" />
      <header className="sheet__header">
        <h1 id={titleId}>{title}</h1>
        <Button variant="ghost" iconOnly aria-label={t('close')} onClick={onClose}>
          <Close size={24} />
        </Button>
      </header>
      <div className="sheet__content">{children}</div>
      <footer className="sheet__actions">{actions}</footer>
    </dialog>
  );
}
