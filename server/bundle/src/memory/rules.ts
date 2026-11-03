/** The sole policy table for memory storage and validation. Limits count Unicode characters. */
export const memoryRules = {
  entry: 300,
  index: 4_000,
  topic: 16_000,
  topics: 40,
  snapshotDays: 30,
  journalRows: 200,
  secrets: [
    /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/i,
    /\b(?:sk|pk|rk)-(?:[a-z]+-)?[a-z0-9_-]{16,}/i,
    /\b(?:gh[pousr]_[a-z0-9_]{20,}|github_pat_[a-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/i,
    /(?:\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|token|password|passwd|secret)|密码|口令|密钥)\s*[:=：]\s*["']?[^\s"']+/i,
    /\bBearer\s+[a-z0-9._~+/-]{8,}/i,
    /\beyJ[a-z0-9_-]+\.eyJ[a-z0-9_-]+\.[a-z0-9_-]+/i,
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:]+:[^\s/@]+@/i,
  ],
} as const;

export const characters = (value: string) => Array.from(value).length;
