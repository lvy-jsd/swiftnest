import { useEffect, useId, useRef } from 'react';
import type { MouseEvent, ReactNode } from 'react';
import { useI18n } from '../i18n';
import { icons } from '../design/icons';
import { IconButton } from './IconButton';
import { trapDialogFocus } from './dialogFocus';

export type SheetProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  presentation?: 'sheet' | 'drawer';
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
export function Sheet({ open, onClose, title, children, actions, presentation = 'sheet' }: SheetProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const { t } = useI18n();
  const Close = icons.close;
  useEffect(() => {
    const element = dialog.current;
    if (open && !element?.open) {
      element?.showModal();
      if (presentation === 'drawer') element?.focus({ preventScroll: true });
    } else if (!open && element?.open) element.close();
  }, [open, presentation]);
  return (
    <dialog
      ref={dialog}
      tabIndex={-1}
      className={presentation}
      aria-labelledby={presentation === 'sheet' ? titleId : undefined}
      aria-label={presentation === 'drawer' ? title : undefined}
      onClose={() => {
        if (open) onClose();
      }}
      onClick={(event) => closeOnBackdrop(event, onClose)}
      onKeyDown={trapDialogFocus}
    >
      {presentation === 'sheet' && <div className="sheet__grabber" aria-hidden="true" />}
      {presentation === 'sheet' && (
        <header className="sheet__header">
          <h1 id={titleId}>{title}</h1>
          <IconButton variant="ghost" aria-label={t('close')} onClick={onClose}>
            <Close size={24} />
          </IconButton>
        </header>
      )}
      <div className="sheet__content">{children}</div>
      {actions && <footer className="sheet__actions">{actions}</footer>}
    </dialog>
  );
}
