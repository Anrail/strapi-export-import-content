import { describe, expect, it } from 'vitest';

import { diffRow } from '../server/src/codec/diff';
import { buildColumns } from '../server/src/codec/schema';
import { articleModel } from './helpers/models';

const columns = buildColumns(articleModel, { nonLocalized: [] });
const current = {
  title: 'Hello',
  views: 5,
  cover: 'http://x/a.jpg',
  tags: ['cat2', 'cat1'],
  seo: { id: 3, metaTitle: 'T' },
  body: null,
};

describe('diffRow', () => {
  it('reports nothing for an identical row', () => {
    expect(diffRow({ ...current }, current, columns)).toEqual({ set: [], clear: [] });
  });

  it('ignores absent and undefined columns', () => {
    expect(diffRow({ title: 'Hello', views: undefined }, current, columns)).toEqual({ set: [], clear: [] });
  });

  it('reports changed scalars, lists and nested objects', () => {
    const file = { title: 'Hi', views: 5, tags: ['cat1', 'cat2'], seo: { metaTitle: 'T2', id: 3 } };
    expect(diffRow(file, current, columns)).toEqual({ set: ['title', 'tags', 'seo'], clear: [] });
  });

  it('does not care about key order inside objects', () => {
    expect(diffRow({ seo: { metaTitle: 'T', id: 3 } }, current, columns)).toEqual({ set: [], clear: [] });
  });

  it('separates clears from sets', () => {
    expect(diffRow({ title: null, cover: null, body: null, views: 6 }, current, columns)).toEqual({
      set: ['views'],
      clear: ['title', 'cover'],
    });
  });
});
