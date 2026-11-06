import type { ReactNode } from 'react';
import { useI18n } from '../i18n';
import { icons } from '../design/icons';
import { IconButton } from './IconButton';
import { ChatIcon } from './ChatIcon';
import { usePageNavigation } from './PageNavigation';
import { useConnection } from '../connection';

export type PageHeaderProps = {
  title: string;
  subtitle?: string;
  large?: boolean;
  onBack?: () => void;
  onTitleClick?: () => void;
  action?: ReactNode;
  children?: ReactNode;
};

function MenuButton({ chat }: { chat: boolean }) {
  const navigation = usePageNavigation();
  const { t } = useI18n();
  const Menu = icons.menu;
  if (!navigation) return null;
  return (
    <IconButton
      className="page-header__menu"
      aria-label={t('shell.openNavigation')}
      aria-expanded={navigation.drawer}
      onClick={navigation.openDrawer}
    >
      {chat ? <ChatIcon name="menu" /> : <Menu size={24} />}
    </IconButton>
  );
}

function NewChatButton({ onClick }: { onClick: () => void }) {
  const { t } = useI18n();
  const { status } = useConnection();
  if (status !== 'connected') return null;
  return (
    <IconButton className="page-header__new-chat" aria-label={t('newChat')} onClick={onClick}>
      <ChatIcon name="write" />
    </IconButton>
  );
}

function HeaderAction({ chat }: { chat: boolean }) {
  const navigation = usePageNavigation();
  const { t } = useI18n();
  const Settings = icons.settings;
  if (!navigation) return null;
  if (chat) return <NewChatButton onClick={navigation.newChat} />;
  return (
    <IconButton aria-label={t('openPreferences')} onClick={navigation.openPreferences}>
      <Settings size={20} />
    </IconButton>
  );
}

function HeaderTitles({ title, subtitle, onTitleClick }: Pick<PageHeaderProps, 'title' | 'subtitle' | 'onTitleClick'>) {
  const { t } = useI18n();
  const { status } = useConnection();
  if (onTitleClick)
    return (
      <h1 className="page-header__titles" aria-label={title}>
        <button
          type="button"
          className="chat-title"
          title={t('chatActions')}
          onClick={onTitleClick}
          aria-label={t('openPreferences')}
        >
          <span className="chat-title__name">{title}</span>
          {subtitle && (
            <span className="chat-title__status">
              <span className="status-dot chat-connection-dot" data-status={status} role="img" aria-label={t(status)} />
              {subtitle}
            </span>
          )}
        </button>
      </h1>
    );
  return (
    <div className="page-header__titles">
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
    </div>
  );
}

export function PageHeader({ title, subtitle, large, onBack, onTitleClick, action, children }: PageHeaderProps) {
  const { t } = useI18n();
  const Back = icons.back;
  const back = onBack && (
    <IconButton className="page-header__back" variant="ghost" onClick={onBack} aria-label={t('back')}>
      {onTitleClick ? <ChatIcon name="back" /> : <Back size={20} />}
    </IconButton>
  );
  return (
    <header className={`page-header glass${large ? ' page-header--large' : ''}`} data-chat={!!onTitleClick}>
      <div className="page-header__row">
        <MenuButton chat={!!onTitleClick} />
        {back}
        <HeaderTitles title={title} subtitle={subtitle} onTitleClick={onTitleClick} />
        <HeaderAction chat={!!onTitleClick} />
        {action && <div className="page-header__action">{action}</div>}
      </div>
      {children}
    </header>
  );
}
