/**
 * Semantic retrieval for the lead engine.
 *
 * Keyword overlap was the original scorer and it has a specific, observed
 * failure: a prospect asking "help me with pricing" matched nothing against an
 * item titled "what should I charge", because the two share no literal token.
 * The coach then honestly declined a question it could actually answer. Cold
 * prospects arrive using their own vocabulary, not the creator's, so that
 * mismatch is the common case rather than an edge case.
 *
 * Vectors live in D1 alongside the row and similarity is computed in JS. One
 * creator's corpus is tens to low hundreds of items, so a brute-force pass is
 * microseconds and avoids standing up Vectorize for a dataset that fits in
 * memory — the same reasoning that kept curriculum search in JS.
 */

/** 768 dims, 512-token input cap, batch-capable. */
export const EMBEDDING_MODEL = '@cf/baai/bge-base-en-v1.5';
export const EMBEDDING_DIMS = 768;

/**
 * BGE is trained asymmetrically: passages are embedded bare, but queries are
 * meant to carry this instruction prefix. Skipping it costs real retrieval
 * accuracy, and it must NOT be applied when embedding stored items.
 */
const QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

/** ~512 tokens. Truncating beats a hard model error on a long guidance field. */
const MAX_CHARS = 1800;

export interface AiBinding {
  run(model: string, inputs: { text: string[] }): Promise<{ data: number[][] }>;
}

function truncate(s: string): string {
  return s.length <= MAX_CHARS ? s : s.slice(0, MAX_CHARS);
}

/**
 * The text that represents a knowledge item in vector space.
 *
 * Both fields, not just one: `problem` is phrased the way a prospect would ask
 * and carries most of the matching signal, while `guidance` holds the concrete
 * terms — so a question using words that only appear in the answer still finds
 * its item.
 */
export function embeddingTextForItem(problem: string, guidance: string): string {
  return truncate(`${problem}\n\n${guidance}`);
}

/** Embeds passages (stored items). No query prefix — see QUERY_PREFIX. */
export async function embedPassages(ai: AiBinding, texts: string[]): Promise<Float32Array[]> {
  if (!texts.length) return [];
  const res = await ai.run(EMBEDDING_MODEL, { text: texts.map(truncate) });
  return res.data.map((v) => Float32Array.from(v));
}

/** Embeds a prospect's question. Carries the query prefix BGE expects. */
export async function embedQuery(ai: AiBinding, question: string): Promise<Float32Array> {
  const res = await ai.run(EMBEDDING_MODEL, { text: [QUERY_PREFIX + truncate(question)] });
  const first = res.data[0];
  if (!first) throw new Error('embedding model returned no vector');
  return Float32Array.from(first);
}

/** Float32Array -> base64, ~4KB per vector versus ~15KB as a JSON array. */
export function encodeVector(v: Float32Array): string {
  const bytes = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

export function decodeVector(s: string): Float32Array | null {
  try {
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const v = new Float32Array(bytes.buffer);
    return v.length === EMBEDDING_DIMS ? v : null;
  } catch {
    return null;
  }
}

/**
 * Cosine similarity. BGE vectors are already L2-normalised, so this is really
 * a dot product, but normalising defensively costs nothing and keeps the
 * function honest if the model is ever swapped for one that is not.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}
