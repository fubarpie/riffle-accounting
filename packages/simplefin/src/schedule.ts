/** Deterministic minute (1-59) per connection so fetches avoid the top of the hour. */
export function randomMinuteSchedule(seed: string): number {
  let h = 0x811c9dc5; // FNV-1a 32-bit
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 1 + (h % 59);
}
