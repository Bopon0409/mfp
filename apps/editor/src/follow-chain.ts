/** Reject both a path back to ourselves and an already cyclic target chain. */
export function canFollow(self: string, target: string, next: (id: string) => string | null | undefined): boolean {
  const seen = new Set([self]);
  let id: string | null | undefined = target;
  while (id) {
    if (seen.has(id)) return false;
    seen.add(id);
    id = next(id);
  }
  return true;
}
