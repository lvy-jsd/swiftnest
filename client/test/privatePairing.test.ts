import { expect, it } from 'vitest';
import { privatePairingStores } from '../src/privatePairing';
it('migrates a legacy credential, serializes secret and rotation, survives reload and clears both on unpair', async () => {
  let value: string | undefined = 'old-token';
  const storage = {
    load: async () => value,
    save: async (_root: string, next: string | undefined) => {
      value = next;
    },
  };
  const stores = privatePairingStores(storage);
  expect(await stores.nativePairingStore!.load('http://home/')).toBe('old-token');
  await Promise.all([
    stores.relaySecretStore!.save('http://home/', 'secret'),
    stores.nativePairingStore!.save('http://home/', 'rotated'),
  ]);
  const reopened = privatePairingStores(storage);
  expect(await reopened.nativePairingStore!.load('http://home/')).toBe('rotated');
  expect(await reopened.relaySecretStore!.load('http://home/')).toBe('secret');
  await reopened.nativePairingStore!.save('http://home/', undefined);
  expect(value).toBeUndefined();
});
