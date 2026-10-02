import { describe, expect, it } from 'vitest';

import { decodeValue, parseCell, stripRelations } from '../server/src/codec/decode';
import type { DecodeCtx } from '../server/src/codec/decode';
import { CellError } from '../server/src/errors';
import { articleModel, getModel } from './helpers/models';

const attr = (name: string) => (articleModel.attributes as any)[name];
const col = (name: string, kind: any) => ({ attribute: attr(name), kind });

const makeCtx = (over: Partial<DecodeCtx> = {}): DecodeCtx => ({
  getModel,
  isLocalized: (uid) => uid.startsWith('api::'),
  publicUrl: 'http://localhost:3000',
  sourceLocalized: true,
  rowLocale: 'en',
  defaultLocale: 'en',
  stripIds: false,
  skipMissingRelations: false,
  resolvers: {
    media: async (url) => (url === '/uploads/a.jpg' ? { id: 7 } : url === '/uploads/dup.jpg' ? 'ambiguous' : 'missing'),
    relationExists: async (_uid, documentId, locale) => documentId.startsWith('cat') && locale === 'en',
  },
  ...over,
});

describe('parseCell', () => {
  it('normalizes scalars and maps empty cells to null', () => {
    expect(parseCell(col('views', 'scalar'), '12', true)).toBe(12);
    expect(parseCell(col('seo', 'component'), '', true)).toBeNull();
  });

  it('parses json cells only in flat formats', () => {
    expect(parseCell(col('meta', 'json'), '{"a":1}', true)).toEqual({ a: 1 });
    expect(parseCell(col('meta', 'json'), '"just text"', true)).toBe('just text');
    expect(parseCell(col('meta', 'json'), 'just text', false)).toBe('just text');
    expect(() => parseCell(col('meta', 'json'), '{broken', true)).toThrow(/not valid JSON/);
  });

  it('reads media as one URL or a list', () => {
    expect(parseCell(col('cover', 'media'), 'http://x/a.jpg', true)).toBe('http://x/a.jpg');
    expect(parseCell(col('gallery', 'media'), '["http://x/a.jpg","http://x/b.jpg"]', true)).toEqual(['http://x/a.jpg', 'http://x/b.jpg']);
    expect(parseCell(col('gallery', 'media'), 'http://x/a.jpg', true)).toEqual(['http://x/a.jpg']);
    expect(parseCell(col('gallery', 'media'), '[]', true)).toBeNull();
    expect(() => parseCell(col('cover', 'media'), '["a","b"]', true)).toThrow(/one URL/);
    expect(() => parseCell(col('gallery', 'media'), '[1]', true)).toThrow(CellError);
  });

  it('reads relation references in both forms', () => {
    expect(parseCell(col('category', 'relation'), 'cat1', true)).toBe('cat1');
    expect(parseCell(col('category', 'relation'), '{"documentId":"cat1","locale":"uk"}', true)).toEqual({ documentId: 'cat1', locale: 'uk' });
    expect(parseCell(col('category', 'relation'), '{"documentId":"cat1"}', true)).toBe('cat1');
    expect(parseCell(col('tags', 'relation'), '["cat2","cat1"]', true)).toEqual(['cat2', 'cat1']);
    expect(() => parseCell(col('category', 'relation'), '["cat1","cat2"]', true)).toThrow(/one reference/);
    expect(() => parseCell(col('tags', 'relation'), '[{"id":1}]', true)).toThrow(/documentId/);
  });

  it('rejects broken or mis-shaped component cells', () => {
    expect(() => parseCell(col('seo', 'component'), '{"metaTitle":', true)).toThrow(/not valid JSON/);
    expect(() => parseCell(col('seo', 'component'), '[1,2]', true)).toThrow(/JSON object/);
    expect(() => parseCell(col('quotes', 'component'), '{"text":"x"}', true)).toThrow(/array of objects/);
    expect(() => parseCell(col('blocks', 'dynamiczone'), '[{"text":"x"}]', true)).toThrow(/__component/);
    expect(parseCell(col('quotes', 'component'), '[]', true)).toBeNull();
  });
});

describe('decodeValue', () => {
  it('passes scalars and json through', async () => {
    expect(await decodeValue(attr('title'), 'scalar', 'Hi', makeCtx())).toEqual({ value: 'Hi', errors: [], warnings: [] });
    expect((await decodeValue(attr('meta'), 'json', { a: 1 }, makeCtx())).value).toEqual({ a: 1 });
  });

  it('resolves media URLs to file ids after stripping the public URL', async () => {
    expect((await decodeValue(attr('cover'), 'media', 'http://localhost:3000/uploads/a.jpg', makeCtx())).value).toBe(7);
    expect((await decodeValue(attr('gallery'), 'media', ['/uploads/a.jpg'], makeCtx())).value).toEqual([7]);
    expect((await decodeValue(attr('cover'), 'media', null, makeCtx())).value).toBeNull();
    expect((await decodeValue(attr('gallery'), 'media', null, makeCtx())).value).toEqual([]);
  });

  it('reports an unmatched and an ambiguous media URL, quoting the URL', async () => {
    const missing = await decodeValue(attr('cover'), 'media', 'https://cdn.example.com/gone.jpg?v=2', makeCtx());
    expect(missing.errors).toEqual(['no Media Library file has the URL https://cdn.example.com/gone.jpg?v=2']);
    const dup = await decodeValue(attr('cover'), 'media', '/uploads/dup.jpg', makeCtx());
    expect(dup.errors[0]).toMatch(/several Media Library files/);
  });

  it('writes relations as an ordered set in the row locale', async () => {
    expect((await decodeValue(attr('tags'), 'relation', ['cat2', 'cat1'], makeCtx())).value).toEqual({
      set: [{ documentId: 'cat2' }, { documentId: 'cat1' }],
    });
    expect((await decodeValue(attr('category'), 'relation', null, makeCtx())).value).toEqual({ set: [] });
  });

  it('reports a relation target that does not exist', async () => {
    const result = await decodeValue(attr('category'), 'relation', 'nope', makeCtx());
    expect(result.errors).toEqual(['related entry nope (en) does not exist']);
  });

  it('skips a missing relation with a warning when asked to', async () => {
    const ctx = makeCtx({ rowLocale: 'uk', skipMissingRelations: true });
    const result = await decodeValue(attr('tags'), 'relation', ['cat1'], ctx);
    expect(result).toEqual({ value: { set: [] }, errors: [], warnings: ['related entry cat1 has no uk version - skipped'] });
  });

  it('keeps the locale in the reference from a non-localized source', async () => {
    const ctx = makeCtx({ sourceLocalized: false, rowLocale: null });
    expect((await decodeValue(attr('category'), 'relation', { documentId: 'cat1', locale: 'en' }, ctx)).value).toEqual({
      set: [{ documentId: 'cat1', locale: 'en' }],
    });
    expect((await decodeValue(attr('category'), 'relation', 'cat1', ctx)).value).toEqual({
      set: [{ documentId: 'cat1', locale: 'en' }],
    });
  });

  it('decodes components recursively and keeps their ids', async () => {
    const native = { id: 3, metaTitle: 'T', shareImage: 'http://localhost:3000/uploads/a.jpg', related: 'cat1' };
    expect((await decodeValue(attr('seo'), 'component', native, makeCtx())).value).toEqual({
      id: 3,
      metaTitle: 'T',
      shareImage: 7,
      related: { set: [{ documentId: 'cat1' }] },
    });
  });

  it('strips component ids when creating', async () => {
    const result = await decodeValue(attr('quotes'), 'component', [{ id: 1, text: 'q' }], makeCtx({ stripIds: true }));
    expect(result.value).toEqual([{ text: 'q' }]);
  });

  it('checks component ids against the entry when the known ids are given', async () => {
    const quotes = [{ id: 1, text: 'a' }, { id: 999, text: 'b' }];
    const known = makeCtx({ knownComponentIds: new Set([1]) });
    const result = await decodeValue(attr('quotes'), 'component', quotes, known);
    expect(result.errors).toEqual(['[1]: component id 999 does not belong to this entry - remove the "id" to add it as a new item']);
    expect(result.value).toEqual([{ id: 1, text: 'a' }, { text: 'b' }]);
    const unchecked = await decodeValue(attr('quotes'), 'component', quotes, makeCtx());
    expect(unchecked.errors).toEqual([]);
    expect(unchecked.value).toEqual([{ id: 1, text: 'a' }, { id: 999, text: 'b' }]);
  });

  it('decodes dynamic zones and rejects a foreign component', async () => {
    const ok = await decodeValue(attr('blocks'), 'dynamiczone', [{ __component: 'shared.quote', id: 9, text: 'z' }], makeCtx());
    expect(ok.value).toEqual([{ __component: 'shared.quote', id: 9, text: 'z' }]);
    const bad = await decodeValue(attr('blocks'), 'dynamiczone', [{ __component: 'shared.hero' }], makeCtx());
    expect(bad.errors).toEqual(['[0]: component "shared.hero" is not allowed here']);
  });

  it('reports nested problems with a path', async () => {
    const result = await decodeValue(attr('seo'), 'component', { id: 3, nope: 1, shareImage: '/uploads/x.jpg' }, makeCtx());
    expect(result.errors).toEqual(['nope: unknown field', 'shareImage: no Media Library file has the URL /uploads/x.jpg']);
  });
});

describe('stripRelations', () => {
  it('removes relation attributes at every level', () => {
    const data = {
      title: 'Hi',
      category: { set: [] },
      seo: { id: 3, metaTitle: 'T', related: { set: [] } },
      blocks: [{ __component: 'shared.seo', related: { set: [] }, metaTitle: 'x' }],
    };
    expect(stripRelations(data, articleModel, getModel)).toEqual({
      title: 'Hi',
      seo: { id: 3, metaTitle: 'T' },
      blocks: [{ __component: 'shared.seo', metaTitle: 'x' }],
    });
  });
});

describe('json values in a JSON file', () => {
  it('keeps an empty string as a value, and still reads an empty flat cell as no value', () => {
    const json = { attribute: { type: 'json' }, kind: 'json' as const };
    expect(parseCell(json, '', false)).toBe('');
    expect(parseCell(json, null, false)).toBeNull();
    expect(parseCell(json, '', true)).toBeNull();
    expect(parseCell(json, '""', true)).toBe('');
  });
});
