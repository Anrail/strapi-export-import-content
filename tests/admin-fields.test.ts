import { describe, expect, it } from 'vitest';

import { changedFields } from '../admin/src/utils/fields';

const row = (fields: string[], errors: string[] = []) => ({ fields, errors });

describe('changedFields', () => {
  it('counts each field over the rows without errors, most changed first', () => {
    const rows = [row(['title']), row(['sku', 'title']), row(['sku']), row(['sku']), row(['views'], ['views: bad'])];
    expect(changedFields(rows)).toBe('sku (3), title (2)');
  });

  it('keeps first-seen order for equal counts', () => {
    expect(changedFields([row(['b', 'a'])])).toBe('b (1), a (1)');
  });

  it('lists at most 12 names, then an ellipsis', () => {
    const names = Array.from({ length: 13 }, (_, index) => `f${index}`);
    expect(changedFields([row(names)])).toBe(`${names.slice(0, 12).map((name) => `${name} (1)`).join(', ')}, …`);
  });

  it('returns null when nothing changes', () => {
    expect(changedFields([])).toBeNull();
    expect(changedFields([row([], ['x'])])).toBeNull();
  });
});
