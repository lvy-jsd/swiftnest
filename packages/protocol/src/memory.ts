/** Central server memory. Apps never persist their own memory files. */
export interface MemoryEntry {
  id: string;
  text: string;
  source: string;
  added: string;
  topic?: string;
  line: string;
}
export interface MemoryView {
  entries: MemoryEntry[];
  topics: { name: string; entries: number }[];
}
export interface MemoryTopic {
  topic: string;
  content: string;
}
