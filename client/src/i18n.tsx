import { createContext, useContext, useEffect, useState } from "react";
import type { PropsWithChildren } from "react";

export const en = {
  appName: "Swiftnest", chats: "Chats", chatsSubtitle: "A little room for your next idea.",
  chatNavigation: "Choose a chat", openPreferences: "Open preferences", preferences: "Preferences",
  close: "Close", back: "Go back", search: "Search chats", noChats: "No chats found. Try another search.",
  sampleTitle: "A fresh start", samplePreview: "What would you like to work on?", sampleSubtitle: "Swiftnest · Sample chat",
  secondTitle: "Weekend ideas", secondPreview: "A few ideas for a slower weekend.",
  botName: "Swiftnest", you: "You", welcomeMessage: "What would you like to work on?",
  secondMessage: "A few ideas for a slower weekend. Start with something you enjoy.",
  sampleNotice: "Sample chat. Messages stay here until you reload.", composer: "Write a message", send: "Send message",
  language: "Language", english: "English", chinese: "简体中文", appearance: "Appearance",
  system: "Follow system", light: "Light", dark: "Dark", accent: "Accent",
  iris: "Iris", ocean: "Ocean", jade: "Jade", amber: "Amber", rose: "Rose", custom: "Custom",
  customHue: "Custom hue", reduceMotion: "Reduce motion", reduceTransparency: "Reduce transparency",
  done: "Done", save: "Save", messages: "Messages", chatActions: "Open chat options",
  desktop: "Desktop app", web: "Web app", localOnly: "Try a conversation", skipToContent: "Skip to content",
} as const;
export type StringKey = keyof typeof en;
export type Locale = "en" | "zh-CN";
export const zhCN: Record<StringKey, string> = {
  appName: "Swiftnest", chats: "聊天", chatsSubtitle: "为下一个想法留一点空间。",
  chatNavigation: "选择聊天", openPreferences: "打开偏好设置", preferences: "偏好设置",
  close: "关闭", back: "返回", search: "搜索聊天", noChats: "未找到聊天，请换个关键词。",
  sampleTitle: "新的开始", samplePreview: "你想做些什么？", sampleSubtitle: "Swiftnest · 示例聊天",
  secondTitle: "周末灵感", secondPreview: "几个悠闲度过周末的想法。",
  botName: "Swiftnest", you: "你", welcomeMessage: "你想做些什么？",
  secondMessage: "几个悠闲度过周末的想法，从自己喜欢的事情开始吧。",
  sampleNotice: "示例聊天，消息仅保留至页面刷新。", composer: "输入消息", send: "发送消息",
  language: "语言", english: "English", chinese: "简体中文", appearance: "外观",
  system: "跟随系统", light: "浅色", dark: "深色", accent: "强调色",
  iris: "鸢尾紫", ocean: "海洋蓝", jade: "翡翠绿", amber: "琥珀黄", rose: "玫瑰红", custom: "自定义",
  customHue: "自定义色相", reduceMotion: "减少动态效果", reduceTransparency: "减少透明效果",
  done: "完成", save: "保存", messages: "消息", chatActions: "打开聊天选项",
  desktop: "桌面应用", web: "网页应用", localOnly: "试着聊聊", skipToContent: "跳转到内容",
};
export const tables = { en, "zh-CN": zhCN };
export const translate = (locale: Locale, key: StringKey): string => tables[locale][key];
type I18n = { locale: Locale; setLocale: (locale: Locale) => void; t: (key: StringKey) => string };
const Context = createContext<I18n | null>(null);

export function I18nProvider({ children, initialLocale }: PropsWithChildren<{ initialLocale?: Locale }>) {
  const [locale, setLocale] = useState<Locale>(() => initialLocale ?? (typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en"));
  useEffect(() => { document.documentElement.lang = locale; document.title = translate(locale, "appName"); }, [locale]);
  return <Context value={{ locale, setLocale, t: key => translate(locale, key) }}>{children}</Context>;
}

export function useI18n(): I18n {
  const context = useContext(Context);
  if (!context) throw new Error("useI18n requires I18nProvider");
  return context;
}
