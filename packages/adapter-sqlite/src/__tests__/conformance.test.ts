import { attributionConformance, sortCounts } from '@splithub/node';
import { describe, expect, it } from 'vitest';
import { sqliteStore } from '../index';

describe('attribution conformance: sqliteStore', () => {
  for (const c of attributionConformance) {
    it(c.name, async () => {
      const store = sqliteStore({ file: ':memory:' });
      await store.insertEvents(c.events);
      expect(sortCounts(await store.variantCounts(c.experiment, c.goal))).toEqual(c.expected);
      await store.close?.();
    });
  }
});
