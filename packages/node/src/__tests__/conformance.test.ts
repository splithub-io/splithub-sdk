import { describe, expect, it } from 'vitest';
import { variantCountsSql } from '../attribution';
import { attributionConformance, sortCounts } from '../conformance';
import { createMemoryStore } from '../store';

describe('attribution conformance: memory store', () => {
  for (const c of attributionConformance) {
    it(c.name, async () => {
      const store = createMemoryStore();
      await store.insertEvents(c.events);
      expect(sortCounts(await store.variantCounts(c.experiment, c.goal))).toEqual(c.expected);
    });
  }
});

describe('variantCountsSql', () => {
  it('numbers Postgres placeholders once per name', () => {
    const q = variantCountsSql({ dialect: 'postgres', projectColumn: 'project_id' });
    expect(q.params).toEqual(['project', 'experiment', 'goal']);
    expect(q.sql).not.toContain('?');
    expect(q.bind({ experiment: 'hero', goal: 'signup', project: 'p' })).toEqual(['p', 'hero', 'signup']);
  });

  it('binds positional placeholders in text order', () => {
    const q = variantCountsSql({ dialect: 'mysql' });
    expect(q.sql.split('?').length - 1).toBe(q.params.length);
    expect(q.bind({ experiment: 'hero', goal: 'signup' })).toEqual(['hero', 'hero', 'signup']);
    expect(() => variantCountsSql({ dialect: 'sqlite', table: 'x; drop' })).toThrow();
  });
});
