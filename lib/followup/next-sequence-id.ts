/**
 * Continue a persisted graph's numeric id sequence without reusing React Flow
 * keys. Non-numeric legacy ids do not affect the sequence.
 */
export function nextSequenceId(ids: string[]): number {
  return ids.reduce((largest, id) => {
    const suffix = /-(\d+)$/.exec(id)?.[1];
    if (!suffix) return largest;
    return Math.max(largest, Number(suffix));
  }, 0) + 1;
}
