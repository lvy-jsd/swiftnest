import { useState } from 'react';
import { localizedError } from '@swiftnest/api';
import { useConnection } from './connection';
import { useI18n } from './i18n';
import { Button } from './components/Button';

function useRelaySettings() {
  const { store } = useConnection();
  const client = store.client;
  const { t } = useI18n();
  const [address, setAddress] = useState('');
  const [secret, setSecret] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const check = async () => {
    try {
      const result = await client!.getRelay();
      setAddress(result.address);
      setNotice(t(result.connected ? 'relayConnected' : 'relayDisconnected'));
    } catch (error) {
      setNotice(localizedError(error).message);
    }
  };
  const save = async (disable = false) => {
    setBusy(true);
    try {
      await client!.setRelay(disable ? null : { address: address.trim(), secret: secret.trim() });
      setSecret('');
      setNotice(t('relaySaved'));
      if (disable) setAddress('');
    } catch (error) {
      setNotice(localizedError(error).message);
    } finally {
      setBusy(false);
    }
  };
  return { client, t, address, setAddress, secret, setSecret, notice, busy, check, save };
}
export function RelaySettings() {
  const { client, t, address, setAddress, secret, setSecret, notice, busy, check, save } = useRelaySettings();
  if (!client) return null;
  return (
    <details>
      <summary>{t('relayAdvanced')}</summary>
      <p>{t('relayHelp')}</p>
      <label className="field">
        <span>{t('relayAddress')}</span>
        <input type="url" value={address} onChange={(event) => setAddress(event.target.value)} autoCapitalize="none" />
      </label>
      <label className="field">
        <span>{t('relaySecret')}</span>
        <input
          type="password"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          autoComplete="new-password"
        />
      </label>
      <Button disabled={busy || !address || !secret} onClick={() => void save()}>
        {t('save')}
      </Button>
      <Button disabled={busy} onClick={() => void check()}>
        {t('relayCheck')}
      </Button>
      <Button disabled={busy} onClick={() => void save(true)}>
        {t('relayDisable')}
      </Button>
      <p role="status">{notice}</p>
      <p>{t(client.connectionPath === 'relay' ? 'relayUsingRemote' : 'relayUsingLan')}</p>
    </details>
  );
}
