/**
 * Text normalisation for FTS5 (unicode61 over pre-tokenised text).
 *
 * Spike findings (Node 24, SQLite 3.53): the trigram tokenizer cannot match 2-character CJK queries
 * such as "字段", and Intl.Segmenter splits the same word differently depending on its neighbours
 * ("字段" became "字 段" in one sentence and stayed whole in another), so index and query disagree.
 * CJK runs are therefore indexed as overlapping bigrams (Lucene CJKBigram style), which is context-free;
 * Latin text is split into lowercase alphanumeric words.
 */
const CJK_CHAR = '\\u3040-\\u30ff\\u3400-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af';
const TOKEN = new RegExp(`[${CJK_CHAR}]+|[\\p{L}\\p{N}]+`, 'gu');
const CJK = new RegExp(`[${CJK_CHAR}]`);

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'is', 'are', 'for', 'on', 'with', 'how', 'what', 'why', 'do', 'does', 'we', 'you', 'it', 'this', 'that',
  '怎么', '什么', '如何', '为什', '一下', '这个', '那个', '我们', '你们', '是不', '不是', '可以', '一个', '的话', '么命',
]);

function cjkGrams(run: string): string[] {
  const chars = [...run];
  if (chars.length === 1) return chars;
  const grams: string[] = [];
  for (let i = 0; i < chars.length - 1; i++) grams.push(chars[i]! + chars[i + 1]!);
  return grams;
}

/** Context-free tokens: CJK bigrams + lowercase Latin/number words. */
export function tokens(text: string): string[] {
  const out: string[] = [];
  for (const m of text.normalize('NFKC').toLowerCase().matchAll(TOKEN)) {
    const t = m[0];
    if (CJK.test(t)) out.push(...cjkGrams(t));
    else out.push(t);
  }
  return out;
}

/** Text written into the FTS column. Identifier separators (._/:-) split words so "test.command" indexes as "test command". */
export function indexText(...parts: (string | undefined)[]): string {
  return parts
    .filter((p): p is string => !!p)
    .flatMap((p) => tokens(p.replace(/[._/:-]+/g, ' ')))
    .join(' ');
}

/** FTS5 MATCH expression (OR of quoted terms, ranked by bm25); null when nothing searchable remains. */
export function ftsQuery(text: string): string | null {
  const terms = tokens(text.replace(/[._/:-]+/g, ' ')).filter((t) => !STOPWORDS.has(t) && (t.length > 1 || CJK.test(t)));
  const unique = [...new Set(terms)];
  return unique.length ? unique.map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ') : null;
}

/** Rough token estimate for budgeting: ~4 chars per token for Latin text, ~1.5 per CJK char. */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) if (CJK.test(ch)) cjk++;
  return Math.ceil((text.length - cjk) / 4 + cjk / 1.5);
}
