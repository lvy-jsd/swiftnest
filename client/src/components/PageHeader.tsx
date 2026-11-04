import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import { icons } from '../design/icons';
import { IconButton } from './IconButton';

export type PageHeaderProps = {
  title: string;
  subtitle?: string;
  large?: boolean;
  onBack?: () => void;
  action?: ReactNode;
  children?: ReactNode;
};
export function PageHeader({ title, subtitle, large, onBack, action, children }: PageHeaderProps) {
  const { t } = useI18n();
  const Back = icons.back;
  return (
    <header className={`page-header glass${large ? ' page-header--large' : ''}`}>
      <div className="page-header__row">
        {onBack && (
          <IconButton variant="ghost" onClick={onBack} aria-label={t('back')}>
            <Back size={24} />
          </IconButton>
        )}
        <div className="page-header__titles">
          <h1>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action && <div className="page-header__action">{action}</div>}
      </div>
      {children}
    </header>
  );
}
