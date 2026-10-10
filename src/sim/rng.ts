/**
 * Seeded pseudo-random numbers (mulberry32). The simulation uses this, never Math.random, so the same
 * seed and inputs always give the same game.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Next 32-bit unsigned integer. */
  nextU32(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Integer in [low, high], inclusive. Returns low if the range is empty. */
  int(low: number, high: number): number {
    if (high <= low) return low;
    return low + (this.nextU32() % (high - low + 1));
  }
}
