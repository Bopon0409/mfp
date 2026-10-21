// CLIP tokenizer (BPE) for the SD-Turbo text encoder, like CLIPTokenizer: lowercase,
// words by regex, bytes → characters, merges by rank, end of word is “</w>”. 77 tokens,
// start 49406, end 49407, padding “!” (0).

const BOS = 49406;
const EOS = 49407;
const PAD = 0;
export const CLIP_LENGTH = 77;

const PATTERN = /<\|startoftext\|>|<\|endoftext\|>|'s|'t|'re|'ve|'m|'ll|'d|[\p{L}]+|[\p{N}]|[^\s\p{L}\p{N}]+/giu;

function bytesToUnicode(): string[] {
  const bs: number[] = [];
  for (let b = 33; b <= 126; b++) bs.push(b);
  for (let b = 161; b <= 172; b++) bs.push(b);
  for (let b = 174; b <= 255; b++) bs.push(b);
  const cs = [...bs];
  let n = 0;
  for (let b = 0; b < 256; b++) {
    if (!bs.includes(b)) {
      bs.push(b);
      cs.push(256 + n++);
    }
  }
  const table: string[] = [];
  bs.forEach((b, i) => (table[b] = String.fromCharCode(cs[i]!)));
  return table;
}

export class ClipTokenizer {
  private readonly encoder: Map<string, number>;
  private readonly ranks = new Map<string, number>();
  private readonly cache = new Map<string, string[]>();
  private readonly byteChars = bytesToUnicode();

  /** vocab.json and merges.txt from the model's tokenizer folder. */
  constructor(vocab: Record<string, number>, merges: string) {
    this.encoder = new Map(Object.entries(vocab));
    // As in CLIP: the first line is a version; 49152 − 256 − 2 merges are taken
    const lines = merges.trim().split('\n').slice(1, 49152 - 256 - 2 + 1);
    lines.forEach((line, i) => this.ranks.set(line, i));
  }

  private bpe(token: string): string[] {
    const cached = this.cache.get(token);
    if (cached) return cached;
    let word = [...token.slice(0, -1), `${token.slice(-1)}</w>`];
    for (;;) {
      let best = -1;
      let bestRank = Infinity;
      for (let i = 0; i < word.length - 1; i++) {
        const rank = this.ranks.get(`${word[i]} ${word[i + 1]}`);
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank;
          best = i;
        }
      }
      if (best < 0) break;
      const a = word[best]!;
      const b = word[best + 1]!;
      const next: string[] = [];
      for (let i = 0; i < word.length; i++) {
        if (i < word.length - 1 && word[i] === a && word[i + 1] === b) {
          next.push(a + b);
          i++;
        } else next.push(word[i]!);
      }
      word = next;
      if (word.length === 1) break;
    }
    this.cache.set(token, word);
    return word;
  }

  /** 77 token ids: start, text (truncated), end, padding. */
  encode(text: string): Int32Array {
    const clean = text.replace(/\s+/g, ' ').trim().toLowerCase();
    const ids: number[] = [];
    const utf8 = new TextEncoder();
    // “!” in SD-Turbo is an added padding token: as in CLIPTokenizer, it is split out before BPE
    clean.split('!').forEach((part, i) => {
      if (i > 0) ids.push(PAD);
      for (const match of part.matchAll(PATTERN)) {
        const chars = [...utf8.encode(match[0])].map((b) => this.byteChars[b]!).join('');
        for (const piece of this.bpe(chars)) {
          const id = this.encoder.get(piece);
          if (id !== undefined) ids.push(id);
        }
      }
    });
    const out = new Int32Array(CLIP_LENGTH).fill(PAD);
    const body = ids.slice(0, CLIP_LENGTH - 2);
    out[0] = BOS;
    out.set(body, 1);
    out[body.length + 1] = EOS;
    return out;
  }
}
