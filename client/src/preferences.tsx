import { Button } from './components/Button';
import { ListRow } from './components/ListRow';
import { AppearanceSettings } from './components/AppearanceSettings';
import { Sheet } from './components/Sheet';
import { useTheme } from './design/theme';
import { useI18n, type Locale } from './i18n';
import { ChatSearchAdvanced } from './chatSearchSettings';
import { RelaySettings } from './relaySettings';
import { ApprovalSettingsFields } from './approvalSettings';

function LanguageSetting() {
  const { t, locale, setLocale } = useI18n();
  return (
    <label className="field">
      <span>{t('language')}</span>
      <select aria-label={t('language')} value={locale} onChange={(event) => setLocale(event.target.value as Locale)}>
        <option value="zh-CN">{t('chinese')}</option>
        <option value="en">{t('english')}</option>
      </select>
    </label>
  );
}

function PreferencesNavigation({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const navigate = (route: string) => {
    onClose();
    window.location.hash = route;
  };
  return (
    <div className="preferences-navigation">
      <ListRow title={t('shell.models')} chevron onClick={() => navigate('/models')} />
      <ListRow title={t('shell.plugins')} chevron onClick={() => navigate('/plugins')} />
    </div>
  );
}

function DisplaySettings() {
  const { t } = useI18n();
  const theme = useTheme();
  return (
    <>
      <AppearanceSettings />
      <label className="field">
        <span>{t('customHue')}</span>
        <input
          type="range"
          min={0}
          max={359}
          step={1}
          value={theme.accentHue}
          onChange={(event) => theme.setAccentHue(Number(event.target.value))}
        />
      </label>
      <label className="switch-field">
        <span>{t('reduceMotion')}</span>
        <input
          type="checkbox"
          role="switch"
          checked={theme.reduceMotion}
          aria-checked={theme.reduceMotion}
          onChange={(event) => theme.setReduceMotion(event.target.checked)}
        />
      </label>
      <label className="switch-field">
        <span>{t('reduceTransparency')}</span>
        <input
          type="checkbox"
          role="switch"
          checked={theme.reduceTransparency}
          aria-checked={theme.reduceTransparency}
          onChange={(event) => theme.setReduceTransparency(event.target.checked)}
        />
      </label>
    </>
  );
}

export function Preferences({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('preferences')}
      actions={
        <Button variant="primary" onClick={onClose}>
          {t('done')}
        </Button>
      }
    >
      <div className="field-groups">
        <LanguageSetting />
        <PreferencesNavigation onClose={onClose} />
        <DisplaySettings />
        <ChatSearchAdvanced />
        <ApprovalSettingsFields />
        <RelaySettings />
      </div>
    </Sheet>
  );
}
