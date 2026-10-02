import { describe, expect, it } from 'vitest';

import { absoluteUrl, encodeEntry, flattenRow } from '../server/src/codec/encode';
import type { EncodeCtx } from '../server/src/codec/encode';
import { buildColumns } from '../server/src/codec/schema';
import { articleModel, getModel, nonLocalizedOf } from './helpers/models';

const ctx: EncodeCtx = {
  getModel,
  isLocalized: (uid) => uid.startsWith('api::'),
  publicUrl: 'http://localhost:3000',
  sourceLocalized: true,
};
const columns = buildColumns(articleModel, { nonLocalized: nonLocalizedOf(articleModel) });

const entity = {
  id: 11,
  documentId: 'doc1',
  locale: 'en',
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T17:36:00.000Z',
  title: 'Hello',
  slug: 'hello',
  views: 5,
  body: '<p>a</p>\r\n<p>b</p>',
  meta: { a: 1 },
  cover: { id: 7, url: '/uploads/a.jpg' },
  gallery: [{ id: 8, url: 'https://cdn.example.com/b.jpg' }, { id: 7, url: '/uploads/a.jpg' }],
  category: { documentId: 'cat1', locale: 'en' },
  tags: [{ documentId: 'cat2', locale: 'en' }, { documentId: 'cat1', locale: 'en' }],
  seo: { id: 3, metaTitle: 'T', shareImage: { id: 7, url: '/uploads/a.jpg' }, related: { documentId: 'cat1', locale: 'en' } },
  quotes: [{ id: 1, text: 'q1' }, { id: 2, text: 'q2' }],
  blocks: [{ __component: 'shared.quote', id: 9, text: 'z' }],
  secret: 'hunter2',
};

describe('absoluteUrl', () => {
  it('prefixes relative URLs only', () => {
    expect(absoluteUrl('/uploads/a.jpg', 'http://localhost:3000/')).toBe('http://localhost:3000/uploads/a.jpg');
    expect(absoluteUrl('https://cdn.example.com/b.jpg', 'http://localhost:3000')).toBe('https://cdn.example.com/b.jpg');
  });
});

describe('encodeEntry', () => {
  const row = encodeEntry(entity, columns, ctx, { status: 'published', publishedAt: '2026-09-01T12:00:00.000Z' });

  it('writes the system columns first', () => {
    expect(Object.keys(row).slice(0, 6)).toEqual(['documentId', 'locale', 'updatedAt', 'status', 'createdAt', 'publishedAt']);
    expect(row).toMatchObject({
      documentId: 'doc1',
      locale: 'en',
      updatedAt: '2026-09-01T17:36:00.000Z',
      status: 'published',
      publishedAt: '2026-09-01T12:00:00.000Z',
    });
  });

  it('encodes scalars, json, media and relations', () => {
    expect(row.title).toBe('Hello');
    expect(row.views).toBe(5);
    expect(row.body).toBe('<p>a</p>\n<p>b</p>');
    expect(row.meta).toEqual({ a: 1 });
    expect(row.cover).toBe('http://localhost:3000/uploads/a.jpg');
    expect(row.gallery).toEqual(['https://cdn.example.com/b.jpg', 'http://localhost:3000/uploads/a.jpg']);
    expect(row.category).toBe('cat1');
    expect(row.tags).toEqual(['cat2', 'cat1']);
  });

  it('keeps component ids and encodes nested media and relations', () => {
    expect(row.seo).toEqual({ id: 3, metaTitle: 'T', shareImage: 'http://localhost:3000/uploads/a.jpg', related: 'cat1' });
    expect(row.quotes).toEqual([{ id: 1, text: 'q1' }, { id: 2, text: 'q2' }]);
    expect(row.blocks).toEqual([{ id: 9, __component: 'shared.quote', text: 'z' }]);
  });

  it('never exports passwords or bookkeeping fields', () => {
    expect(row).not.toHaveProperty('secret');
    expect(row).not.toHaveProperty('createdBy');
    expect(row).not.toHaveProperty('id');
  });

  it('encodes missing values and empty lists as null', () => {
    const empty = encodeEntry(
      { documentId: 'doc2', locale: 'en', gallery: [], tags: [], quotes: [], blocks: [] },
      columns,
      ctx,
      { status: 'draft', publishedAt: null },
    );
    for (const field of ['title', 'cover', 'gallery', 'category', 'tags', 'seo', 'quotes', 'blocks']) {
      expect(empty[field]).toBeNull();
    }
  });

  it('uses {documentId, locale} only from a non-localized type to a localized target', () => {
    const plain = encodeEntry(entity, columns, { ...ctx, sourceLocalized: false }, { status: null, publishedAt: null });
    expect(plain.category).toEqual({ documentId: 'cat1', locale: 'en' });
    expect(plain.tags).toEqual([{ documentId: 'cat2', locale: 'en' }, { documentId: 'cat1', locale: 'en' }]);
  });
});

describe('flattenRow', () => {
  it('stringifies complex values and every non-null json value, keeps scalars typed', () => {
    const flat = flattenRow({ title: 'Hello', views: 5, meta: 'just text', tags: ['a', 'b'], seo: { id: 3 }, cover: null }, columns);
    expect(flat).toEqual({ title: 'Hello', views: 5, meta: '"just text"', tags: '["a","b"]', seo: '{"id":3}', cover: null });
  });
});
