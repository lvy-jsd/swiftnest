import type { SessionSummary } from '@swiftnest/api';

export type ChatDateGroup = 'shell.today' | 'shell.yesterday' | 'shell.thisWeek' | 'shell.older';
export type ChatListItem<T = SessionSummary> = { group: ChatDateGroup; chat: T };

/** Local calendar boundaries, Monday first; setDate also handles DST transitions. */
export function groupChats<T extends SessionSummary>(chats: readonly T[], now = new Date()): ChatListItem<T>[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const week = new Date(today);
  week.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  return [...chats]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((chat) => {
      const time = chat.updatedAt;
      const group =
        time >= +today
          ? 'shell.today'
          : time >= +yesterday
            ? 'shell.yesterday'
            : time >= +week
              ? 'shell.thisWeek'
              : 'shell.older';
      return { group, chat };
    });
}

export function greetingKey(hour: number) {
  if (hour < 12) return 'home.morning' as const;
  if (hour < 18) return 'home.afternoon' as const;
  return 'home.evening' as const;
}
