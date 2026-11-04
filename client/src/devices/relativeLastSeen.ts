import type { Locale } from '../i18n';

export function relativeLastSeen(value: string, locale: Locale, now: number) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  const seconds = Math.min(0, (timestamp - now) / 1000);
  const units = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ] as const;
  const [unit, length] = units.find(([, length]) => Math.abs(seconds) >= length) ?? units[units.length - 1]!;
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(Math.ceil(seconds / length), unit);
}
