import { createContext, useContext, useEffect, useState } from "react";
import type { PropsWithChildren } from "react";

export const en = {
  thisDevice: "This device", thisDeviceHelp: "Share this computer with Ivy through your server.",
  letIvyControl: "Let Ivy control this computer", deviceStopped: "Stopped", deviceDisplayName: "Device display name",
  deviceServerAddress: "Device server address", deviceAddressHelp: "Use the device address shown by the server Devices page; its port may differ from the chat server.",
  sharedFolders: "Shared folders", sharedFoldersHelp: "Files and shell commands are confined to these folders. Keys, credentials and browser data stay protected. Save to apply folder changes.",
  noSharedFolders: "No folders shared. Choose a folder before enabling control.", addSharedFolder: "Add shared folder", removeFolder: "Remove folder",
  keepBackground: "Keep running in the background", backgroundHelp: "Closing the window keeps device control running. Open or quit from the tray. Sleep and quitting the App disconnect this device.",
  deviceFingerprint: "This device fingerprint", devicePairHelp: "Create a code on the server Devices page, enter it here, then confirm the fingerprints on both screens.",
  pairThisDevice: "Pair this computer", waitingServerConfirm: "Waiting for confirmation on the server Devices page…",
  unpairThisDevice: "Unpair this computer", unpairThisDeviceHelp: "Stop control and forget the server on this computer. Revoke its entry on the server Devices page too if you no longer use it.",
  deviceActionFailed: "Device control could not complete the action. Check the address, shared folders and server pairing, then retry.",
  devices: "Devices", devicesHelp: "Your paired devices and requests waiting for you.",
  pairDevice: "Pair a device", pairingCode: "Pairing code", pairingExpired: "Code expired. Create a new code.",
  dialAddress: "Device address", nestFingerprint: "Server fingerprint", expires: "Expires",
  compareFingerprints: "Compare fingerprints on both screens before confirming.",
  confirmDevice: "Confirm device", fingerprintMatches: "Fingerprint matches", noDevices: "No paired devices yet.",
  online: "Online", offline: "Offline", capabilities: "Capabilities", lastSeen: "Last seen", none: "None",
  revokeDevice: "Revoke device", revokeHelp: "Disconnect this device and remove its pairing. It must pair again to reconnect.",
  cancel: "Cancel", pendingApprovals: "Waiting for approval", reviewApproval: "Review request", requestedBy: "Requested by",
  risk: "Risk", read: "Read", write: "Write", exec: "Execute", sensitive: "Sensitive", approve: "Approve", deny: "Deny",
  devicesFailed: "Could not update devices or complete the action. Check the connection and retry.",
  appName: "Swiftnest", chats: "Chats", chatsSubtitle: "A little room for your next idea.",
  chatNavigation: "Choose a chat", openPreferences: "Open preferences", preferences: "Preferences",
  close: "Close", back: "Go back", search: "Search chats", noChats: "No chats found. Try another search.",
  botName: "Swiftnest", you: "You", composer: "Write a message", send: "Send message",
  pair: "Pair server", pairUrl: "Pairing URL", pairHelp: "Paste the pairing URL printed by your server.",
  reconnect: "Pair again", disconnected: "Disconnected", connecting: "Connecting…", connected: "Connected",
  pairFailed: "Could not pair. Check the URL and server, then pair again.",
  sameOrigin: "Open the App (web) link on that server to pair in your browser.",
  loadFailed: "Could not load chats. Return to Chats to retry, or pair again.",
  connectionLost: "Connection lost. Pair again to reconnect.",
  newChat: "New chat", untitledChat: "Untitled chat", thinking: "Thinking", seconds: "s",
  sendHelp: "Ctrl/Cmd+Enter to send.", queueHelp: "Messages sent now will queue for the next turn.",
  ranTools: "Ran {count} tools", runningTools: "Running {count} tools", unknownEvent: "Event details",
  followFailed: "Could not open this chat. Return to Chats and try again.",
  sendFailed: "Could not confirm delivery. Check the chat before sending again.",
  language: "Language", english: "English", chinese: "简体中文", appearance: "Appearance",
  system: "Follow system", light: "Light", dark: "Dark", accent: "Accent",
  iris: "Iris", ocean: "Ocean", jade: "Jade", amber: "Amber", rose: "Rose", custom: "Custom",
  customHue: "Custom hue", reduceMotion: "Reduce motion", reduceTransparency: "Reduce transparency",
  done: "Done", save: "Save", messages: "Messages", chatActions: "Open chat options",
  desktop: "Desktop app", web: "Web app", skipToContent: "Skip to content",
} as const;
export type StringKey = keyof typeof en;
export type Locale = "en" | "zh-CN";
export const zhCN: Record<StringKey, string> = {
  thisDevice: "此设备", thisDeviceHelp: "通过服务器，让 Ivy 使用这台电脑。",
  letIvyControl: "允许 Ivy 控制这台电脑", deviceStopped: "已停止", deviceDisplayName: "设备显示名称",
  deviceServerAddress: "设备服务器地址", deviceAddressHelp: "请使用服务器“设备”页面显示的设备连接地址，其端口可能与聊天服务器不同。",
  sharedFolders: "共享文件夹", sharedFoldersHelp: "文件与命令访问限制在这些文件夹内。密钥、凭据与浏览器数据始终受保护。更改文件夹后请保存。",
  noSharedFolders: "尚未共享文件夹，请先选择文件夹再开启控制。", addSharedFolder: "添加共享文件夹", removeFolder: "移除文件夹",
  keepBackground: "在后台保持运行", backgroundHelp: "关闭窗口后继续提供设备控制，可从托盘打开或退出。休眠或退出应用会断开此设备。",
  deviceFingerprint: "此设备指纹", devicePairHelp: "在服务器“设备”页面生成配对码，在此输入，然后在两端核对并确认指纹。",
  pairThisDevice: "配对这台电脑", waitingServerConfirm: "等待服务器“设备”页面确认…",
  unpairThisDevice: "取消此电脑配对", unpairThisDeviceHelp: "停止控制并忘记本机保存的服务器。如果不再使用此电脑，也请在服务器“设备”页面撤销其记录。",
  deviceActionFailed: "无法完成设备控制操作，请检查地址、共享文件夹和服务器配对状态后重试。",
  devices: "设备", devicesHelp: "已配对的设备与等待你确认的请求。",
  pairDevice: "配对设备", pairingCode: "配对码", pairingExpired: "配对码已过期，请生成新码。",
  dialAddress: "设备连接地址", nestFingerprint: "服务器指纹", expires: "有效期至",
  compareFingerprints: "请核对两端屏幕上的指纹后再确认。",
  confirmDevice: "确认设备", fingerprintMatches: "指纹一致", noDevices: "还没有配对设备。",
  online: "在线", offline: "离线", capabilities: "能力", lastSeen: "最近在线", none: "无",
  revokeDevice: "撤销设备", revokeHelp: "断开此设备并移除配对，重新连接需要再次配对。",
  cancel: "取消", pendingApprovals: "等待审批", reviewApproval: "查看请求", requestedBy: "请求方",
  risk: "风险", read: "读取", write: "写入", exec: "执行", sensitive: "敏感操作", approve: "批准", deny: "拒绝",
  devicesFailed: "无法更新设备或完成操作，请检查连接后重试。",
  appName: "Swiftnest", chats: "聊天", chatsSubtitle: "为下一个想法留一点空间。",
  chatNavigation: "选择聊天", openPreferences: "打开偏好设置", preferences: "偏好设置",
  close: "关闭", back: "返回", search: "搜索聊天", noChats: "未找到聊天，请换个关键词。",
  botName: "Swiftnest", you: "你", composer: "输入消息", send: "发送消息",
  pair: "配对服务器", pairUrl: "配对链接", pairHelp: "粘贴服务器启动时打印的配对链接。",
  reconnect: "重新配对", disconnected: "未连接", connecting: "正在连接…", connected: "已连接",
  pairFailed: "配对失败，请检查链接和服务器后重新配对。",
  sameOrigin: "请打开该服务器打印的 App (web) 链接，在浏览器中配对。",
  loadFailed: "无法加载聊天，请返回聊天列表重试或重新配对。",
  connectionLost: "连接已断开，请重新配对。",
  newChat: "新建聊天", untitledChat: "未命名聊天", thinking: "思考中", seconds: "秒",
  sendHelp: "按 Ctrl/Cmd+Enter 发送。", queueHelp: "现在发送的消息会排队等待下一轮。",
  ranTools: "已运行 {count} 个工具", runningTools: "正在运行 {count} 个工具", unknownEvent: "事件详情",
  followFailed: "无法打开聊天，请返回聊天列表重试。",
  sendFailed: "无法确认是否送达，请检查聊天记录后再发送。",
  language: "语言", english: "English", chinese: "简体中文", appearance: "外观",
  system: "跟随系统", light: "浅色", dark: "深色", accent: "强调色",
  iris: "鸢尾紫", ocean: "海洋蓝", jade: "翡翠绿", amber: "琥珀黄", rose: "玫瑰红", custom: "自定义",
  customHue: "自定义色相", reduceMotion: "减少动态效果", reduceTransparency: "减少透明效果",
  done: "完成", save: "保存", messages: "消息", chatActions: "打开聊天选项",
  desktop: "桌面应用", web: "网页应用", skipToContent: "跳转到内容",
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
