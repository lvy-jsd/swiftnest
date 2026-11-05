/** Split by code point, retaining overlap so phrases crossing a boundary remain searchable. */
export function chunkText(text: string, size = 1600, overlap = 160): string[] {
  if (size < 1 || overlap < 0 || overlap >= size) throw new RangeError('Invalid chunk size');
  const points = [...text];
  const chunks: string[] = [];
  for (let start = 0; start < points.length; start += size - overlap) {
    chunks.push(points.slice(start, start + size).join(''));
    if (start + size >= points.length) break;
  }
  return chunks;
}

const TERM_SEPARATOR = /[\s\p{P}\p{S}]+/u;
const CJK_RUN = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7A3\uF900-\uFAFF]+/gu;

export interface QueryParts {
  phrases: string[];
  grams: string[];
}

/** Punctuation separates terms; CJK runs become overlapping bigrams and short terms become grams; the rest are FTS phrases. */
export function queryParts(query: string): QueryParts {
  const phrases: string[] = [];
  const grams: string[] = [];
  for (const term of query.toLowerCase().split(TERM_SEPARATOR).filter(Boolean)) {
    for (const part of term.replace(CJK_RUN, ' ').split(/\s+/u).filter(Boolean)) {
      if ([...part].length >= 3) phrases.push(part);
      else grams.push(part);
    }
    for (const run of term.matchAll(CJK_RUN)) {
      const chars = [...run[0]];
      for (let at = 0; at + 1 < chars.length; at += 1) grams.push(chars.slice(at, at + 2).join(''));
      if (chars.length === 1) grams.push(chars[0]!);
    }
  }
  return { phrases: [...new Set(phrases)].slice(0, 12), grams: [...new Set(grams)].slice(0, 24) };
}

export function snippet(text: string, query: string) {
  const { phrases, grams } = queryParts(query);
  const terms = [...phrases, ...grams];
  const lower = text.toLowerCase();
  const first = Math.min(...terms.map((term) => lower.indexOf(term)).filter((offset) => offset >= 0));
  let start = Number.isFinite(first) ? Math.max(0, first - 65) : 0;
  if (start > 0 && /[\uDC00-\uDFFF]/.test(text[start]!)) start -= 1;
  const excerpt = `${start ? '…' : ''}${[...text.slice(start)].slice(0, 240).join('')}`;
  const ranges: [number, number][] = [];
  const normalized = excerpt.toLowerCase();
  for (const term of terms) {
    for (let at = normalized.indexOf(term); at >= 0; at = normalized.indexOf(term, at + term.length))
      ranges.push([at, at + term.length]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const highlights: [number, number][] = [];
  for (const range of ranges) {
    const previous = highlights.at(-1);
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else highlights.push(range);
  }
  return { snippet: excerpt, highlights };
}

/** Reciprocal rank fusion, k=60; deterministic ties preserve the lexical ordering. */
export function fuseRanks(...rankings: number[][]): number[] {
  const scores = new Map<number, number>();
  for (const ranking of rankings) {
    for (const [rank, id] of [...new Set(ranking)].entries())
      scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + rank + 1));
  }
  return [...scores.keys()].sort((a, b) => scores.get(b)! - scores.get(a)!);
}
