import type { ClientOptions } from '@swiftnest/api';
type Store = NonNullable<ClientOptions['nativePairingStore']>;
interface Record {
  credential?: string;
  relaySecret?: string;
}
/** One atomic private native record. The legacy bare credential remains readable. */
export function privatePairingStores(storage: Store): Pick<ClientOptions, 'nativePairingStore' | 'relaySecretStore'> {
  let writes = Promise.resolve();
  const read = async (root: string): Promise<Record> => {
    const value = await storage.load(root);
    if (!value) return {};
    if (!value.startsWith('{')) return { credential: value };
    return JSON.parse(value) as Record;
  };
  const save = (root: string, field: keyof Record, value?: string) => {
    const write = writes.then(async () => {
      if (field === 'credential' && !value) return storage.save(root, undefined);
      const record = await read(root);
      record[field] = value;
      await storage.save(root, record.relaySecret ? JSON.stringify(record) : record.credential);
    });
    writes = write.catch(() => {});
    return write;
  };
  return {
    nativePairingStore: {
      load: async (root) => (await read(root)).credential,
      save: (root, value) => save(root, 'credential', value),
    },
    relaySecretStore: {
      load: async (root) => (await read(root)).relaySecret,
      save: (root, value) => save(root, 'relaySecret', value),
    },
  };
}
