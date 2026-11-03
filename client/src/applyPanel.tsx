/**
 * The "apply" part of a settings page whose changes restart the assistant: the apply
 * button, restart progress, the restored-after-failure notice and the reconnect card
 * when the restarted server needs a new pairing link.
 */
import { localizedError } from '@swiftnest/api';
import { useConnection } from './connection';
import { useI18n, type StringKey } from './i18n';
import { applyBusy, applyProgress, type Applyable } from './pluginState';
import { Button } from './components/Button';
import { Card } from './components/Card';

/** The page-specific words: progress before the restart, the rollback notice and the help line. */
export type ApplyWords = { preparing: StringKey; restored: StringKey; help: StringKey };

type Failure = { error?: { code: string; message: string; hint: string } };

export function ApplyStatus({
  view,
  words,
  restarting = false,
}: {
  view: Applyable & { apply: Failure };
  words: ApplyWords;
  restarting?: boolean;
}) {
  const { t, locale } = useI18n();
  const progress = applyProgress(view);
  const progressKey = progress === 'restarting' ? 'pluginsRestarting' : progress && words[progress];
  const failure =
    view.apply.state === 'failed' && !view.apply.rolledBack && view.apply.error
      ? localizedError(view.apply.error, locale)
      : undefined;
  if (!progressKey && !restarting && !failure) return null;
  return (
    <Card className="plugin-apply" role={failure ? 'alert' : 'status'}>
      {restarting ? t('pluginsRestarting') : progressKey ? t(progressKey) : null}
      {failure && (
        <>
          <p>{failure.message}</p>
          <p>{failure.hint}</p>
        </>
      )}
    </Card>
  );
}

export function ApplyPanel({
  view,
  words,
  busy,
  page,
  apply,
}: {
  view: Applyable & { apply: Failure };
  words: ApplyWords;
  busy: boolean;
  /** Where pairing again returns to. */
  page: 'plugins' | 'models';
  apply: () => void;
}) {
  const { store, pluginRestart, status } = useConnection();
  const { t } = useI18n();
  if (pluginRestart === 'pair-required')
    return (
      <Card className="plugin-apply" role="status">
        <h2>{t('pluginsPairRequired')}</h2>
        <p>{t('pluginsPairHelp')}</p>
        <a className="button button--primary" href={`#/pair?return=${page}`}>
          {t('pluginsReconnect')}
        </a>
      </Card>
    );
  const start = () => {
    store.expectPluginRestart(true);
    apply();
  };
  return (
    <>
      <ApplyStatus view={view} words={words} restarting={!!pluginRestart} />
      {(view.pending || view.apply.state === 'failed') && !pluginRestart && (
        <Card className="plugin-apply">
          <p>{t(words.help)}</p>
          <Button variant="primary" disabled={busy || applyBusy(view) || status !== 'connected'} onClick={start}>
            {t(view.apply.state === 'failed' ? 'pluginsRetry' : 'pluginsApply')}
          </Button>
        </Card>
      )}
    </>
  );
}
