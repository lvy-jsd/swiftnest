const paths = {
  back: 'M19 12H5m6-6-6 6 6 6',
  menu: 'M5 7h14M5 12h14M5 17h14',
  write: 'm15 5 4 4M5 19l4-1L20 7l-3-3L6 15l-1 4Z',
  send: 'M12 19V5m-6 6 6-6 6 6',
  attach: 'm9 12 5-5a3 3 0 0 1 4 4l-7 7a5 5 0 0 1-7-7l8-8',
  close: 'm6 6 12 12M6 18 18 6',
  check: 'm5 12 4 4L19 6',
  chevron: 'm7 10 5 5 5-5',
  clock: 'M12 8v4l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  file: 'M14 3H6v18h12V7l-4-4Zm0 0v5h4M9 12h6M9 16h4',
  chat: 'M20 11a8 8 0 0 1-8 8H5l-3 2V11a9 9 0 0 1 18 0Z',
} as const;

/** Chat's line icons share one 24 px artboard and one stroke weight. */
export function ChatIcon({ name }: { name: keyof typeof paths }) {
  return (
    <svg
      className="chat-icon"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name]} />
    </svg>
  );
}
