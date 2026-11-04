import { presets } from '../design/palette';
import { useTheme } from '../design/theme';
import { useI18n } from '../i18n';
import { Card } from './Card';
import { Chip } from './Chip';
import { ListRow } from './ListRow';

function ThemeChoices() {
  const { t } = useI18n();
  const theme = useTheme();
  return (
    <Card className="preferences-group">
      <ListRow title={t('appearance')} value={t(theme.preference)} />
      <fieldset className="chip-group" aria-label={t('appearance')}>
        {(['system', 'light', 'dark'] as const).map((mode) => (
          <Chip key={mode} selected={theme.preference === mode} onClick={() => theme.setPreference(mode)}>
            {t(mode)}
          </Chip>
        ))}
      </fieldset>
    </Card>
  );
}

function AccentChoices() {
  const { t } = useI18n();
  const theme = useTheme();
  const chosenPreset = Object.entries(presets).find(([, hue]) => hue === theme.accentHue)?.[0] ?? 'custom';
  return (
    <Card className="preferences-group">
      <ListRow title={t('accent')} value={t(chosenPreset as keyof typeof presets | 'custom')} />
      <fieldset className="chip-group" aria-label={t('accent')}>
        {Object.entries(presets).map(([name, hue]) => (
          <Chip key={name} selected={theme.accentHue === hue} onClick={() => theme.setAccentHue(hue)}>
            {t(name as keyof typeof presets)}
          </Chip>
        ))}
        <Chip selected={chosenPreset === 'custom'} onClick={() => theme.setAccentHue(0)}>
          {t('custom')}
        </Chip>
      </fieldset>
    </Card>
  );
}

export function AppearanceSettings() {
  return (
    <>
      <ThemeChoices />
      <AccentChoices />
    </>
  );
}
