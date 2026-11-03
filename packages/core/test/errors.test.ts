import { expect, it } from 'vitest';
import { localizedError, text } from '@swiftnest/protocol';
import { SwiftnestFailure } from '../src/errors';

it('sends English prose for logs and models plus catalog text for each reader', () => {
  const failure = new SwiftnestFailure(
    'DEVICE_OFFLINE',
    text('deviceNotConnected', 'laptop'),
    text('hintWaitForReconnect'),
    true,
  );
  expect(failure.message).toBe('Device "laptop" is not connected.');
  const wire = failure.toJSON();
  expect(wire).toMatchObject({
    code: 'DEVICE_OFFLINE',
    message: 'Device "laptop" is not connected.',
    hint: 'Wait for it to reconnect, then retry.',
    text: { key: 'deviceNotConnected', args: ['laptop'] },
    hintText: { key: 'hintWaitForReconnect' },
    retryable: true,
  });
  expect(localizedError(wire, 'zh-CN').message).toBe('设备“laptop”未连接。');
});

it('keeps a prose hint beside catalog text', () => {
  const wire = new SwiftnestFailure('X', text('cancelledRequest'), 'Try again later.').toJSON();
  expect(localizedError(wire, 'en')).toMatchObject({ message: 'Cancelled by request.', hint: 'Try again later.' });
});
