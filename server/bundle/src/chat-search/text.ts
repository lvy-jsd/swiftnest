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

export function queryTerms(query: string): string[] {
  return [...new Set(query.trim().toLowerCase().split(/\s+/u).filter(Boolean))].slice(0, 12);
}

/** All values stay bound parameters; quoted phrases make operators and punctuation literal. */
export function fullTextQuery(query: string) {
  const terms = queryTerms(query);
  return {
    match: terms
      .filter((term) => [...term].length >= 3)
      .map((term) => `"${term.replaceAll('"', '""')}"`)
      .join(' AND '),
    short: terms.filter((term) => [...term].length < 3).map((term) => `%${term.replace(/[\\%_]/g, '\\$&')}%`),
  };
}

export function snippet(text: string, query: string) {
  const terms = queryTerms(query);
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
