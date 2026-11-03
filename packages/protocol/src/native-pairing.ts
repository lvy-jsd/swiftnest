/** Opaque native App bearer credential shared by its issuer, admission and SDK carrier. */
export const NATIVE_PAIRING_COOKIE = 'swiftnest_native';
export function isNativePairingCredential(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}
