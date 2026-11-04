import { useEffect, useId, useRef } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { useI18n } from '../i18n';
import { icons } from '../design/icons';
import { IconButton } from './IconButton';

export type SheetProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
};

function closeOnBackdrop(event: MouseEvent<HTMLDialogElement>, onClose: () => void) {
  if (event.target !== event.currentTarget) return;
  const rect = event.currentTarget.getBoundingClientRect();
  if (
    event.clientX < rect.left ||
    event.clientX > rect.right ||
    event.clientY < rect.top ||
    event.clientY > rect.bottom
  )
    onClose();
}

/** Native modal gives focus trapping, Escape dismissal and an inert background. */
export function Sheet({ open, onClose, title, children, actions }: SheetProps) {
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
    // biome-ignore lint/a11y/useKeyWithClickEvents: the click closes on the backdrop; Escape closes natively via onClose
    <dialog
      ref={dialog}
      className="sheet"
      aria-labelledby={titleId}
      onClose={() => {
        if (open) onClose();
      }}
      onClick={(event) => closeOnBackdrop(event, onClose)}
    >
      <div className="sheet__grabber" aria-hidden="true" />
      <header className="sheet__header">
        <h1 id={titleId}>{title}</h1>
        <IconButton variant="ghost" aria-label={t('close')} onClick={onClose}>
          <Close size={24} />
        </IconButton>
      </header>
      <div className="sheet__content">{children}</div>
      {actions && <footer className="sheet__actions">{actions}</footer>}
    </dialog>
  );
}
