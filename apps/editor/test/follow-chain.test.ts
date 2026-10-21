import { expect, it } from 'vitest';
import { canFollow } from '../src/follow-chain.ts';

it('allows a leader or an open chain, rejects mutual and indirect follow loops', () => {
  const links = new Map<string, string>();
  const next = (id: string) => links.get(id);
  expect(canFollow('a', 'b', next)).toBe(true);
  links.set('b', 'a'); expect(canFollow('a', 'b', next)).toBe(false);
  links.set('b', 'c'); expect(canFollow('a', 'b', next)).toBe(true);
  links.set('c', 'a'); expect(canFollow('a', 'b', next)).toBe(false);
  links.set('c', 'b'); expect(canFollow('a', 'b', next)).toBe(false);
  expect(canFollow('a', 'a', next)).toBe(false);
});
