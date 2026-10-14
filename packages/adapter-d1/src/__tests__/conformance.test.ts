import { attributionConformance, sortCounts } from '@splithub/node';
import { describe, expect, it } from 'vitest';
import { d1Schema, d1Store } from '../index';
import { sqliteD1 } from '../testing';

describe('attribution conformance: d1Store', () => {
  for (const c of attributionConformance) {
    it(c.name, async () => {
      const db = sqliteD1();
      await db.exec(d1Schema());
      const store = d1Store(db, { project: 'proj_a' });
      // Another project's copy of the same events must not leak in.
      await d1Store(db, { project: 'proj_b' }).insertEvents(c.events.map((e) => ({ ...e, props: { revenue: 1000 } })));
      await store.insertEvents(c.events);
      expect(sortCounts(await store.variantCounts(c.experiment, c.goal))).toEqual(c.expected);
    });
  }
});
