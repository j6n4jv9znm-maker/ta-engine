import { describe, expect, it } from 'vitest';
import { hasGameData } from '../src/testData';

describe('scaffold', () => {
  it('runs tests', () => {
    expect(1 + 1).toBe(2);
  });
});

// Pattern for every test that needs real game files: skip cleanly when data/ is empty.
describe.skipIf(!hasGameData())('game data', () => {
  it('finds at least one archive in data/', () => {
    expect(hasGameData()).toBe(true);
  });
});
