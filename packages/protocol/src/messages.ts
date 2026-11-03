/**
 * The message catalog, shared with the Rust hosts (native/locale). Keys name what the message says;
 * keep them stable once shipped. Placeholders are `{0}`, `{1}`, ... in both languages.
 */
import en from './locales/en.json' with { type: 'json' };
import zh from './locales/zh-CN.json' with { type: 'json' };

export const messageEn: typeof en = en;
/** Typed against English, so a key missing in Chinese fails to compile. */
export const messageZh: Record<keyof typeof en, string> = zh;
