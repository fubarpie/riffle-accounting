import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/uuid.js';

describe('uuidv7', () => {
  it('has version 7, RFC variant, and is monotonic', () => {
    const ids = Array.from({ length: 5000 }, () => uuidv7());
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
