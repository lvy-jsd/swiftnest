import { afterEach, expect, it } from 'vitest';
import { ApiError } from '../src/transport';
import { text } from '../src/index';

afterEach(() => {
  delete process.env.SWIFTNEST_LANG;
});

it("shows a server failure in the App's language from its catalog text", () => {
  process.env.SWIFTNEST_LANG = 'en';
  const body = { code: 'DEVICE_OFFLINE', message: '设备已离线', text: { key: 'deviceOffline' } };
  const error = ApiError.fromServer('device-conflict', body, text('deviceApiReturnedHttp', 409));
  expect(error).toMatchObject({ code: 'device-conflict', serverCode: 'DEVICE_OFFLINE', message: 'Device is offline' });
  expect(error.text).toEqual({ key: 'deviceOffline' });
});

it('falls back to the status text when the server sent no body', () => {
  process.env.SWIFTNEST_LANG = 'en';
  const error = ApiError.fromServer('http-error', undefined, text('deviceApiReturnedHttp', 502));
  expect(error.message).toBe('Device API returned HTTP 502');
});
