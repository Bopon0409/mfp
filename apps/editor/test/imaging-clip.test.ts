import { describe, expect, it } from 'vitest';
import { CLIP_LENGTH, ClipTokenizer } from '../src/imaging/clip-tokenizer.ts';

// A small vocabulary in CLIP format: merges by rank, end of word — “</w>”
const vocab = { '!': 0, 'r': 1, 'e': 2, 'd': 3, 'red</w>': 10, 're': 11, ',</w>': 12, 'a</w>': 13, 'd</w>': 14, '<|startoftext|>': 49406, '<|endoftext|>': 49407 };
const merges = ['#version: 0.2', 'r e', 're d</w>'].join('\n');

describe('image enhancements: CLIP tokenizer', () => {
  it('start, words via merges, end and padding with “!”', () => {
    const ids = new ClipTokenizer(vocab, merges).encode('  Red,   a ');
    expect(ids.length).toBe(CLIP_LENGTH);
    expect([...ids.slice(0, 6)]).toEqual([49406, 10, 12, 13, 49407, 0]);
    expect(ids.slice(5).every((v) => v === 0)).toBe(true);
  });

  it('“!” is a separate token 0, like the added token in SD-Turbo', () => {
    expect([...new ClipTokenizer(vocab, merges).encode('red!a').slice(0, 5)]).toEqual([49406, 10, 0, 13, 49407]);
  });

  it('long text is truncated to 75 tokens, the end token stays last', () => {
    const ids = new ClipTokenizer(vocab, merges).encode(Array.from({ length: 200 }, () => 'a').join(' '));
    expect(ids[0]).toBe(49406);
    expect(ids[CLIP_LENGTH - 1]).toBe(49407);
    expect(ids.slice(1, CLIP_LENGTH - 1).every((v) => v === 13)).toBe(true);
  });
});
